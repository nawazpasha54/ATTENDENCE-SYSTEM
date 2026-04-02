const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Database ──────────────────────────────────────────────────────────────────
const DB_DIR = process.env.RENDER ? '/tmp' : path.join(__dirname, 'db');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const db = new Database(path.join(DB_DIR, 'attendance.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    roll_no TEXT UNIQUE NOT NULL,
    department TEXT,
    photo_data TEXT,
    password TEXT DEFAULT 'student123',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    teacher TEXT,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    radius INTEGER DEFAULT 100,
    monitor_minutes INTEGER DEFAULT 40,
    date TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER,
    session_id INTEGER,
    marked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    lat REAL,
    lng REAL,
    face_matched INTEGER DEFAULT 0,
    -- GPS tracking status
    status TEXT DEFAULT 'monitoring',
    -- 'monitoring' | 'confirmed' | 'absent_left' | 'absent_gps_off'
    monitoring_start DATETIME DEFAULT CURRENT_TIMESTAMP,
    monitoring_end DATETIME,
    last_ping DATETIME DEFAULT CURRENT_TIMESTAMP,
    ping_count INTEGER DEFAULT 0,
    violations INTEGER DEFAULT 0,
    FOREIGN KEY(student_id) REFERENCES students(id),
    FOREIGN KEY(session_id) REFERENCES sessions(id),
    UNIQUE(student_id, session_id)
  );

  CREATE TABLE IF NOT EXISTS gps_pings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attendance_id INTEGER,
    student_id INTEGER,
    session_id INTEGER,
    lat REAL,
    lng REAL,
    distance_from_class REAL,
    inside_fence INTEGER,
    ping_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(attendance_id) REFERENCES attendance(id)
  );

  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT
  );
`);

// Default admin
const existingAdmin = db.prepare('SELECT id FROM admins WHERE username=?').get('admin');
if (!existingAdmin) db.prepare('INSERT INTO admins (username,password) VALUES (?,?)').run('admin','admin123');

// ── Multer (memory — photos stored as base64 in DB) ──────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5*1024*1024 } });

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ── AUTH ──────────────────────────────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  const admin = db.prepare('SELECT * FROM admins WHERE username=? AND password=?').get(username, password);
  if (admin) res.json({ success: true });
  else res.status(401).json({ success: false, message: 'Invalid credentials' });
});

app.post('/api/student/login', (req, res) => {
  const { roll_no, password } = req.body;
  const s = db.prepare('SELECT id,name,roll_no,department,photo_data,created_at FROM students WHERE roll_no=? AND password=?').get(roll_no, password);
  if (s) res.json({ success: true, student: s });
  else res.status(401).json({ success: false, message: 'Invalid Roll Number or password' });
});


app.get('/api/students', (req, res) => {
  const rows = db.prepare(`SELECT id,name,roll_no,department,created_at,
    CASE WHEN photo_data IS NOT NULL THEN 1 ELSE 0 END as has_photo
    FROM students ORDER BY name`).all();
  res.json(rows);
});

app.get('/api/students/:id/photo', (req, res) => {
  const s = db.prepare('SELECT photo_data FROM students WHERE id=?').get(req.params.id);
  if (!s || !s.photo_data) return res.status(404).json({ error: 'No photo' });
  res.json({ photo_data: s.photo_data });
});

app.post('/api/students', upload.single('photo'), (req, res) => {
  const { name, roll_no, department, password } = req.body;
  let photo_data = null;
  if (req.file) {
    photo_data = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
  }
  try {
    const r = db.prepare('INSERT INTO students (name,roll_no,department,photo_data,password) VALUES (?,?,?,?,?)')
      .run(name, roll_no, department, photo_data, password || 'student123');
    res.json({ success: true, id: r.lastInsertRowid });
  } catch(e) {
    if (e.message.includes('UNIQUE')) res.status(400).json({ success: false, message: 'Roll number already exists' });
    else res.status(500).json({ success: false, message: e.message });
  }
});

app.delete('/api/students/:id', (req, res) => {
  db.prepare('DELETE FROM students WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── SESSIONS ──────────────────────────────────────────────────────────────────
app.get('/api/sessions', (req, res) => {
  res.json(db.prepare('SELECT * FROM sessions ORDER BY created_at DESC').all());
});

app.get('/api/sessions/active', (req, res) => {
  const s = db.prepare('SELECT * FROM sessions WHERE active=1 ORDER BY created_at DESC LIMIT 1').get();
  res.json(s || null);
});

app.post('/api/sessions', (req, res) => {
  const { subject, teacher, lat, lng, radius, monitor_minutes, date } = req.body;
  const r = db.prepare('INSERT INTO sessions (subject,teacher,lat,lng,radius,monitor_minutes,date) VALUES (?,?,?,?,?,?,?)')
    .run(subject, teacher, lat, lng, radius || 100, monitor_minutes || 40, date);
  res.json({ success: true, id: r.lastInsertRowid });
});

app.patch('/api/sessions/:id/close', (req, res) => {
  db.prepare('UPDATE sessions SET active=0 WHERE id=?').run(req.params.id);
  // Mark all still-monitoring students as confirmed (session ended)
  db.prepare(`UPDATE attendance SET status='confirmed', monitoring_end=CURRENT_TIMESTAMP
    WHERE session_id=? AND status='monitoring'`).run(req.params.id);
  res.json({ success: true });
});

// ── ATTENDANCE — MARK ─────────────────────────────────────────────────────────
app.post('/api/attendance/mark', (req, res) => {
  const { student_id, session_id, lat, lng, face_matched } = req.body;

  const session = db.prepare('SELECT * FROM sessions WHERE id=? AND active=1').get(session_id);
  if (!session) return res.status(400).json({ success: false, message: 'Session not found or not active' });

  const dist = getDistance(lat, lng, session.lat, session.lng);
  if (dist > session.radius) {
    return res.status(400).json({ success: false, message: `You are ${Math.round(dist)}m away. Must be within ${session.radius}m.` });
  }

  try {
    db.prepare(`INSERT INTO attendance
      (student_id,session_id,lat,lng,face_matched,status,monitoring_start,last_ping,ping_count)
      VALUES (?,?,?,?,?,'monitoring',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1)`)
      .run(student_id, session_id, lat, lng, face_matched ? 1 : 0);

    // Log first ping
    const att = db.prepare('SELECT id FROM attendance WHERE student_id=? AND session_id=?').get(student_id, session_id);
    db.prepare('INSERT INTO gps_pings (attendance_id,student_id,session_id,lat,lng,distance_from_class,inside_fence) VALUES (?,?,?,?,?,?,1)')
      .run(att.id, student_id, session_id, lat, lng, Math.round(dist));

    res.json({ success: true, attendance_id: att.id, monitor_minutes: session.monitor_minutes });
  } catch(e) {
    if (e.message.includes('UNIQUE')) res.status(400).json({ success: false, message: 'Attendance already marked for this session' });
    else res.status(500).json({ success: false, message: e.message });
  }
});

// ── GPS PING (called every 60s by student's browser) ─────────────────────────
app.post('/api/attendance/ping', (req, res) => {
  const { student_id, session_id, lat, lng, gps_available } = req.body;

  const att = db.prepare('SELECT a.*, s.lat as slat, s.lng as slng, s.radius, s.monitor_minutes FROM attendance a JOIN sessions s ON a.session_id=s.id WHERE a.student_id=? AND a.session_id=?')
    .get(student_id, session_id);

  if (!att) return res.status(404).json({ error: 'Attendance record not found' });
  if (att.status === 'confirmed') return res.json({ status: 'confirmed', message: 'Already confirmed present' });
  if (att.status === 'absent_left' || att.status === 'absent_gps_off') {
    return res.json({ status: att.status, message: 'Marked absent' });
  }

  const now = Date.now();
  const start = new Date(att.monitoring_start).getTime();
  const elapsedMin = (now - start) / 60000;

  // ── GPS disabled / unavailable ──
  if (!gps_available || lat == null || lng == null) {
    const newViolations = att.violations + 1;
    db.prepare('UPDATE attendance SET violations=?, last_ping=CURRENT_TIMESTAMP, ping_count=ping_count+1 WHERE id=?')
      .run(newViolations, att.id);
    db.prepare('INSERT INTO gps_pings (attendance_id,student_id,session_id,lat,lng,distance_from_class,inside_fence) VALUES (?,?,?,?,?,?,?)')
      .run(att.id, student_id, session_id, null, null, null, 0);

    // 2 consecutive GPS-off pings → mark absent
    if (newViolations >= 2) {
      db.prepare(`UPDATE attendance SET status='absent_gps_off', monitoring_end=CURRENT_TIMESTAMP WHERE id=?`).run(att.id);
      return res.json({ status: 'absent_gps_off', message: 'Marked absent: GPS was turned off' });
    }
    return res.json({ status: 'warning_gps', violations: newViolations, message: 'GPS signal lost — warning' });
  }

  const dist = getDistance(lat, lng, att.slat, att.slng);
  const inside = dist <= att.radius;

  // Log ping
  db.prepare('INSERT INTO gps_pings (attendance_id,student_id,session_id,lat,lng,distance_from_class,inside_fence) VALUES (?,?,?,?,?,?,?)')
    .run(att.id, student_id, session_id, lat, lng, Math.round(dist), inside ? 1 : 0);

  if (!inside) {
    // Left geo-fence
    db.prepare(`UPDATE attendance SET status='absent_left', monitoring_end=CURRENT_TIMESTAMP,
      violations=violations+1, last_ping=CURRENT_TIMESTAMP, ping_count=ping_count+1 WHERE id=?`).run(att.id);
    return res.json({
      status: 'absent_left',
      distance: Math.round(dist),
      message: `Marked absent: left classroom zone (${Math.round(dist)}m away, limit ${att.radius}m)`
    });
  }

  // Reset violations on good ping
  const newCount = att.ping_count + 1;
  db.prepare('UPDATE attendance SET violations=0, last_ping=CURRENT_TIMESTAMP, ping_count=? WHERE id=?').run(newCount, att.id);

  // ── Check if monitoring period complete ──
  if (elapsedMin >= att.monitor_minutes) {
    db.prepare(`UPDATE attendance SET status='confirmed', monitoring_end=CURRENT_TIMESTAMP WHERE id=?`).run(att.id);
    return res.json({ status: 'confirmed', elapsed_min: Math.round(elapsedMin), message: `✅ Confirmed present after ${att.monitor_minutes} minutes!` });
  }

  const remaining = Math.max(0, att.monitor_minutes - elapsedMin);
  return res.json({
    status: 'monitoring',
    inside: true,
    distance: Math.round(dist),
    elapsed_min: Math.round(elapsedMin),
    remaining_min: Math.round(remaining),
    ping_count: newCount,
    message: `In zone — ${Math.round(remaining)} minutes remaining`
  });
});

// ── GET monitoring status (for student page) ─────────────────────────────────
app.get('/api/attendance/status', (req, res) => {
  const { student_id, session_id } = req.query;
  const att = db.prepare(`SELECT a.*, s.monitor_minutes, s.radius FROM attendance a
    JOIN sessions s ON a.session_id=s.id
    WHERE a.student_id=? AND a.session_id=?`).get(student_id, session_id);
  if (!att) return res.json(null);

  const pings = db.prepare('SELECT * FROM gps_pings WHERE attendance_id=? ORDER BY ping_time DESC LIMIT 20').all(att.id);
  res.json({ ...att, recent_pings: pings });
});

// ── ATTENDANCE — LIST & EXPORT ────────────────────────────────────────────────
app.get('/api/attendance', (req, res) => {
  const { session_id } = req.query;
  let q = `SELECT a.*, s.name as student_name, s.roll_no, s.department,
    ss.subject, ss.date, ss.monitor_minutes, ss.radius
    FROM attendance a
    JOIN students s ON a.student_id=s.id
    JOIN sessions ss ON a.session_id=ss.id`;
  const params = [];
  if (session_id) { q += ' WHERE a.session_id=?'; params.push(session_id); }
  q += ' ORDER BY a.marked_at DESC';
  res.json(db.prepare(q).all(...params));
});

// Live monitoring board for admin (only monitoring/absent students)
app.get('/api/attendance/live', (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'session_id required' });
  const rows = db.prepare(`SELECT a.*, s.name as student_name, s.roll_no,
    ss.lat as class_lat, ss.lng as class_lng, ss.radius, ss.monitor_minutes
    FROM attendance a
    JOIN students s ON a.student_id=s.id
    JOIN sessions ss ON a.session_id=ss.id
    WHERE a.session_id=?
    ORDER BY a.status, s.name`).all(session_id);

  // Add latest ping to each
  const result = rows.map(r => {
    const ping = db.prepare('SELECT * FROM gps_pings WHERE attendance_id=? ORDER BY ping_time DESC LIMIT 1').get(r.id);
    return { ...r, latest_ping: ping };
  });
  res.json(result);
});

app.get('/api/attendance/export', (req, res) => {
  const { session_id } = req.query;
  let q = `SELECT s.roll_no, s.name, s.department, ss.subject, ss.date,
    a.marked_at, a.face_matched, a.status, a.ping_count,
    CASE a.status
      WHEN 'confirmed' THEN 'Present'
      WHEN 'monitoring' THEN 'Pending'
      WHEN 'absent_left' THEN 'Absent (Left Zone)'
      WHEN 'absent_gps_off' THEN 'Absent (GPS Off)'
      ELSE 'Unknown'
    END as final_status
    FROM attendance a
    JOIN students s ON a.student_id=s.id
    JOIN sessions ss ON a.session_id=ss.id`;
  const params = [];
  if (session_id) { q += ' WHERE a.session_id=?'; params.push(session_id); }
  q += ' ORDER BY s.roll_no';

  const rows = db.prepare(q).all(...params);
  const header = 'Roll No,Name,Department,Subject,Date,Marked At,Face Matched,GPS Pings,Final Status\n';
  const csv = header + rows.map(r =>
    `${r.roll_no},"${r.name}",${r.department||''},${r.subject},${r.date},${r.marked_at},${r.face_matched?'Yes':'No'},${r.ping_count},${r.final_status}`
  ).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=attendance.csv');
  res.send(csv);
});

// ── Student's personal history + stats ───────────────────────────────────────
app.get('/api/student/:id/attendance', (req, res) => {
  res.json(db.prepare(`SELECT a.*, ss.subject, ss.date, ss.teacher
    FROM attendance a JOIN sessions ss ON a.session_id=ss.id
    WHERE a.student_id=? ORDER BY a.marked_at DESC`).all(req.params.id));
});

app.get('/api/student/:id/stats', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as c FROM sessions').get().c;
  const confirmed = db.prepare(`SELECT COUNT(*) as c FROM attendance WHERE student_id=? AND status='confirmed'`).get(req.params.id).c;
  const monitoring = db.prepare(`SELECT COUNT(*) as c FROM attendance WHERE student_id=? AND status='monitoring'`).get(req.params.id).c;
  const absent = db.prepare(`SELECT COUNT(*) as c FROM attendance WHERE student_id=? AND status IN ('absent_left','absent_gps_off')`).get(req.params.id).c;
  const bySubject = db.prepare(`
    SELECT ss.subject,
      COUNT(*) as attended,
      SUM(CASE WHEN a.status='confirmed' THEN 1 ELSE 0 END) as confirmed_count,
      (SELECT COUNT(*) FROM sessions s2 WHERE s2.subject=ss.subject) as total_count
    FROM attendance a JOIN sessions ss ON a.session_id=ss.id
    WHERE a.student_id=? GROUP BY ss.subject`).all(req.params.id);
  const present = confirmed + monitoring;
  res.json({ total, present, confirmed, monitoring, absent, percentage: total>0?Math.round((confirmed/total)*100):0, bySubject });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2-lat1)*Math.PI/180, dLon = (lon2-lon1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R*2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

app.listen(PORT, () => {
  console.log(`\n✅ Server running at http://localhost:${PORT}`);
  console.log(`📋 Admin: admin / admin123`);
  console.log(`🌐 Deploy free: https://render.com\n`);
});
