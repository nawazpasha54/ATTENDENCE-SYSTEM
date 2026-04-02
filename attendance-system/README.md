# 🎓 Smart Attendance System
### Face Recognition + Geo-Fencing | Engineering Project Demo

## ✨ Features
| Feature | Details |
|---------|---------|
| 📸 Face Recognition | Browser-based via face-api.js — no Python needed |
| 📍 Geo-Fencing | Haversine GPS check — must be within X meters of class |
| 👨‍💼 Admin Dashboard | Create sessions, manage students, export CSV |
| 🎓 Student Dashboard | Personal attendance history, subject-wise stats, % tracker |
| 🔒 Student Login | Roll number + password login |
| 📊 CSV Export | Download full attendance report |
| 🌐 Free Deployment | Works on Render/Railway — no SSL or custom domain needed |

---

## 🚀 Option A: Run Locally

```bash
npm install
npm start
# Open: http://localhost:3000

# Share with friends via ngrok (free):
npx ngrok http 3000
```

---

## ☁️ Option B: Deploy FREE on Render (Permanent URL, No SSL/Domain needed)

1. Push this folder to GitHub (create free account at github.com)
2. Go to https://render.com → Sign up → New → Web Service
3. Connect your GitHub repo
4. Set: Build = `npm install`, Start = `node server.js`, Plan = Free
5. Deploy → get URL like `https://smart-attendance.onrender.com`
6. Share that URL with anyone!

> Free tier sleeps after 15 min inactivity, first wake takes ~30s. Fine for demo.

## 🚂 Option C: Deploy FREE on Railway

1. Go to https://railway.app → Sign up with GitHub
2. New Project → Deploy from GitHub repo → select repo
3. Settings → Domains → Generate Domain
4. Get URL like `https://yourapp.up.railway.app`

---

## 👨‍💼 Usage

**Admin:** Go to `/admin` → login `admin`/`admin123` → Add students → Create session (uses your GPS) → Share URL → Close session after class → Export CSV

**Student:** Go to `/student` → login with roll number + password → view stats + history → click Mark Attendance

---

## 🔐 Default Credentials
| Role | Login | Password |
|------|-------|----------|
| Admin | `admin` | `admin123` |
| Student | their roll no | `student123` |

---

## 🗂️ Structure
```
server.js          # Express backend
public/
  index.html       # Home page
  student.html     # Student dashboard (NEW)
  mark.html        # Attendance marking (face + geo)
  admin.html       # Admin panel
  css/style.css
render.yaml        # Render deploy config
Procfile           # Railway deploy config
```

## 🛠️ Tech Stack
Node.js + Express · SQLite · face-api.js · Browser Geolocation API · Haversine formula · Vanilla HTML/CSS/JS
