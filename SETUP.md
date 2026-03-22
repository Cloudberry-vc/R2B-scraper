# Cloudberry Research Radar — Setup Guide

## Architecture

```
GitHub Repo (everything lives here)
├── index.html / app.js / style.css  ──→ served via GitHub Pages
├── sources.json                      ──→ list of URLs to monitor
├── keywords.json                     ──→ thesis keyword categories
├── data/projects.json                ──→ scraper output (auto-updated)
└── scripts/scraper.py                ──→ runs via GitHub Actions
```

- **Every Monday at 09:00 Helsinki time**, GitHub Actions runs the scraper
- Scraper reads `sources.json`, fetches each URL, classifies projects
- Results are committed back to `data/projects.json`
- GitHub Pages auto-serves the site from `main` branch

---

## Step 1 — Create GitHub Repository

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR-ORG/research-radar.git
git push -u origin main
```

## Step 2 — Enable GitHub Pages

1. Go to your repo → **Settings → Pages**
2. Source: **Deploy from a branch**
3. Branch: `main` / `/ (root)`
4. Click **Save**

Your site will be live at `https://YOUR-ORG.github.io/research-radar/`

## Step 3 — Create a GitHub Personal Access Token

1. GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens**
2. Create a new token scoped to your repo with:
   - **Contents: Read and Write** (to update sources.json / keywords.json)
   - **Actions: Write** (to trigger the scrape workflow manually)
3. Copy the token — you only see it once

## Step 4 — Connect the UI to GitHub

1. Open the live site
2. Click **Sources** in the toolbar
3. Fill in:
   - **Repository**: `your-org/research-radar`
   - **Token**: your PAT from Step 3
   - **Branch**: `main`
4. Click **Connect**

Your token is saved only in your browser's localStorage — it is never sent anywhere except directly to the GitHub API.

## Step 5 — Add URLs to Monitor

With the site open, click **Sources** and add URLs one by one:
- Enter a label (e.g. `Aalto Research Projects`)
- Enter the URL to scrape (e.g. `https://research.aalto.fi/en/projects/`)
- Click **Add**

Each addition writes directly to `sources.json` in your repo via GitHub API.

## Step 6 — Run Your First Scrape

Click **Scrape Now** in the toolbar, or:
1. Go to your repo → **Actions** → `Weekly Research Radar Scrape`
2. Click **Run workflow**

The scraper runs, updates `data/projects.json`, commits it, and GitHub Pages serves the new data.

---

## Customising Keywords

Click **Keywords** in the toolbar to add/remove thesis keywords per category.
Changes are saved directly to `keywords.json` in the repo and take effect on the next scrape.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| "GitHub not configured" | Open Sources and connect with your PAT |
| "GitHub write failed: 403" | Token needs Contents + Actions write permissions |
| No projects appearing | Run the workflow manually first (Actions tab) |
| Scraper finds nothing | Check that your source URLs load real project listings |
