# Cloudberry Research Radar — Setup Guide

## What This Is

A weekly research project scanner that monitors Finnish university research portals and flags projects relevant to the Cloudberry thesis (semiconductors, photonics, advanced materials, optics, equipment, quantum).

## Architecture

```
GitHub Repo
├── Frontend (HTML/CSS/JS) ──→ Deployed on Netlify
├── sources.json ──→ List of URLs to monitor
├── data/projects.json ──→ Scraped results (auto-updated)
├── scripts/scraper.py ──→ Runs via GitHub Actions
└── netlify/functions/ ──→ Handles source management from UI
```

- **Every Monday at 09:00 Helsinki time**, GitHub Actions runs the scraper
- Scraper fetches each source URL, extracts projects, classifies relevance
- Results are committed to `data/projects.json`
- Netlify auto-deploys from the repo, so the site updates automatically

## Step-by-Step Setup

### 1. Create GitHub Repository

```bash
cd cloudberry-radar
git init
git add .
git commit -m "Initial commit: Cloudberry Research Radar"
git branch -M main
git remote add origin https://github.com/YOUR-ORG/research-radar.git
git push -u origin main
```

### 2. Deploy to Netlify

1. Go to [app.netlify.com](https://app.netlify.com)
2. Click "Add new site" → "Import an existing project"
3. Connect your GitHub account and select the `research-radar` repo
4. Build settings should auto-detect from `netlify.toml`:
   - Publish directory: `.`
   - Functions directory: `netlify/functions`
5. Click "Deploy"

### 3. Configure Environment Variables (Netlify)

In Netlify → Site Settings → Environment Variables, add:

| Variable | Value | Description |
|----------|-------|-------------|
| `GITHUB_TOKEN` | `ghp_xxxxxxxxxxxx` | GitHub Personal Access Token with `repo` scope |
| `GITHUB_REPO` | `your-org/research-radar` | Your repo in `owner/repo` format |
| `GITHUB_BRANCH` | `main` | Branch name |

To create a GitHub token:
1. Go to GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens
2. Create a new token with **Contents: Read and Write** permission on the repo

### 4. Enable GitHub Actions

The workflow runs automatically on the `schedule` trigger. To test it immediately:
1. Go to your repo → Actions tab
2. Select "Weekly Research Radar Scrape"
3. Click "Run workflow" → "Run workflow"

### 5. Share with Colleagues

Share the Netlify URL (e.g. `https://research-radar.netlify.app`). Anyone with the link can:
- Browse and search all scraped projects
- Filter by relevance, university, category
- Add new sources via the "Manage Sources" button

## Transferring to Cloudflare Pages

When ready to move from Netlify to Cloudflare Pages:

1. Go to Cloudflare dashboard → Pages → Create a project
2. Connect your GitHub repo
3. Set build output directory to `.` (root)
4. For the Netlify Function, you'll need to port `manage-sources.js` to a Cloudflare Worker
5. Set the same environment variables in Cloudflare Pages settings

## Adding Sources

**Via the UI:**
Click "Manage Sources" in the toolbar, fill in the form, click "Add Source".

**Via the repo:**
Edit `sources.json` directly and commit. The scraper will pick up the new source on the next run.

## Customizing Keywords

Edit the `KEYWORD_MAP` dictionary in `scripts/scraper.py` to add or modify thesis-relevant keywords.

## Troubleshooting

- **No projects showing up?** Run the GitHub Action manually first (Actions tab → Run workflow)
- **Source management not saving?** Check that `GITHUB_TOKEN`, `GITHUB_REPO` are set in Netlify env vars
- **Scraper timing?** The cron `0 7 * * 1` = Monday 07:00 UTC = 09:00 Helsinki time
