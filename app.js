/* ============================================
   Cloudberry VC Research Radar — App Logic
   All listed projects are active & thesis-qualifying.
   ============================================ */

const DATA_URL     = 'data/projects.json';
const SOURCES_URL  = 'sources.json';
const KEYWORDS_URL = 'keywords.json';

let allProjects = [];
let allSources  = [];
let allKeywords = {};
let dataMetadata = {};

// ---- GitHub Config (stored in localStorage) ----
const GH_CONFIG_KEY = 'cloudberry_gh_config';

function getGHConfig() {
  try { return JSON.parse(localStorage.getItem(GH_CONFIG_KEY) || 'null'); }
  catch { return null; }
}

function saveGHConfig(token, repo, branch) {
  localStorage.setItem(GH_CONFIG_KEY, JSON.stringify({ token, repo, branch: branch || 'main' }));
}

async function ghReadFile(filePath) {
  const cfg = getGHConfig();
  if (!cfg) throw new Error('GitHub not configured. Open Sources and connect your repo first.');
  const res = await fetch(
    `https://api.github.com/repos/${cfg.repo}/contents/${filePath}?ref=${cfg.branch}`,
    { headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github.v3+json' } }
  );
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  return res.json();
}

async function ghWriteFile(filePath, content, message, sha) {
  const cfg = getGHConfig();
  if (!cfg) throw new Error('GitHub not configured.');
  // btoa with UTF-8 support
  const encoded = btoa(unescape(encodeURIComponent(content)));
  const res = await fetch(
    `https://api.github.com/repos/${cfg.repo}/contents/${filePath}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message, content: encoded, sha, branch: cfg.branch }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub write failed: ${res.status} — ${err}`);
  }
  return res.json();
}

// ---- Dismissed Projects (persisted in localStorage) ----
const DISMISSED_KEY = 'cloudberry_dismissed_projects';

function getDismissedIds() {
  try { return JSON.parse(localStorage.getItem(DISMISSED_KEY) || '[]'); }
  catch { return []; }
}
function dismissProject(id) {
  const dismissed = getDismissedIds();
  if (!dismissed.includes(id)) {
    dismissed.push(id);
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(dismissed));
  }
  renderProjects();
  updateStats();
  showToast('Project dismissed. It won\'t appear again.');
}
function undismissAll() {
  localStorage.removeItem(DISMISSED_KEY);
  renderProjects();
  updateStats();
  showToast('All dismissed projects restored.');
}

// ---- Init ----
document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  renderGHConfig();
  await loadSources();
  await loadKeywords();
  await loadProjects();
});

function setupEventListeners() {
  document.getElementById('searchInput').addEventListener('input', debounce(renderProjects, 250));
  document.getElementById('filterCountry').addEventListener('change', renderProjects);
  document.getElementById('filterUniversity').addEventListener('change', renderProjects);
  document.getElementById('filterCategory').addEventListener('change', renderProjects);
  document.getElementById('btnSources').addEventListener('click', () => toggleModal('sourcesModal', true));
  document.getElementById('closeSourcesModal').addEventListener('click', () => toggleModal('sourcesModal', false));
  document.getElementById('closeDetailModal').addEventListener('click', () => toggleModal('detailModal', false));
  document.getElementById('btnAddSource').addEventListener('click', addSource);
  document.getElementById('btnKeywords').addEventListener('click', () => toggleModal('keywordsModal', true));
  document.getElementById('closeKeywordsModal').addEventListener('click', () => toggleModal('keywordsModal', false));
  document.getElementById('btnAddCategory').addEventListener('click', addKeywordCategory);
  document.getElementById('btnScrapeNow').addEventListener('click', triggerScrape);
  document.getElementById('btnSaveGH').addEventListener('click', onSaveGHConfig);
  document.getElementById('btnDisconnectGH').addEventListener('click', onDisconnectGH);

  // Allow Enter key in add-source inputs
  document.getElementById('newSourceUrl').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addSource();
  });

  // Close modals on overlay click
  document.querySelectorAll('.modal-overlay').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target === el) toggleModal(el.id, false);
    });
  });

  // Keyboard close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay.active').forEach(el => toggleModal(el.id, false));
    }
  });
}

// ---- GitHub Config UI ----
function renderGHConfig() {
  const cfg = getGHConfig();
  const setupEl = document.getElementById('ghSetup');
  const statusEl = document.getElementById('ghConnected');
  const repoLabel = document.getElementById('ghConnectedRepo');

  if (cfg && cfg.token && cfg.repo) {
    setupEl.style.display = 'none';
    statusEl.style.display = '';
    repoLabel.textContent = cfg.repo;
  } else {
    setupEl.style.display = '';
    statusEl.style.display = 'none';
  }
}

function onSaveGHConfig() {
  const token  = document.getElementById('ghToken').value.trim();
  const repo   = document.getElementById('ghRepo').value.trim();
  const branch = document.getElementById('ghBranch').value.trim() || 'main';

  if (!token || !repo) {
    showToast('Please enter both a token and repository.', 'error');
    return;
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    showToast('Repository must be in format owner/repo.', 'error');
    return;
  }

  saveGHConfig(token, repo, branch);
  renderGHConfig();
  showToast('GitHub connected.', 'success');
}

function onDisconnectGH() {
  if (!confirm('Disconnect GitHub? You will need to re-enter your token to save changes.')) return;
  localStorage.removeItem(GH_CONFIG_KEY);
  renderGHConfig();
}

// ---- Data Loading ----
async function loadProjects() {
  try {
    const res = await fetch(DATA_URL);
    if (!res.ok) throw new Error('No data yet');
    const data = await res.json();
    allProjects = data.projects || [];
    dataMetadata = {
      by_category: data.by_category || {},
      by_country:  data.by_country  || {},
    };
    if (data.last_updated) {
      document.getElementById('lastUpdated').textContent = `Last scan: ${formatDate(data.last_updated)}`;
    }
    updateStats();
    populateFilters();
    renderProjects();
  } catch {
    allProjects = [];
    renderProjects();
  }
}

async function loadSources() {
  try {
    const res = await fetch(SOURCES_URL);
    if (!res.ok) throw new Error('No sources');
    allSources = await res.json();
    renderSources();
  } catch {
    allSources = [];
    renderSources();
  }
}

// ---- Stats ----
function updateStats() {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const dismissed = getDismissedIds();

  document.getElementById('statTotal').textContent =
    allProjects.filter(p => !dismissed.includes(p.id)).length;
  document.getElementById('statNew').textContent =
    allProjects.filter(p => p.first_seen && new Date(p.first_seen) > weekAgo).length;
  document.getElementById('statSources').textContent = allSources.length;

  const countries = [...new Set(allProjects.map(p => p.country).filter(Boolean))];
  document.getElementById('statCountries').textContent = countries.length;
}

// ---- Filters ----
function populateFilters() {
  const countrySel = document.getElementById('filterCountry');
  const countries = [...new Set(allProjects.map(p => p.country).filter(Boolean))].sort();
  countrySel.innerHTML = '<option value="all">All Countries</option>';
  countries.forEach(c => {
    const count = allProjects.filter(p => p.country === c).length;
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = `${c} (${count})`;
    countrySel.appendChild(opt);
  });

  const uniSel = document.getElementById('filterUniversity');
  const orgs = [...new Set(allProjects.map(p => p.source_org).filter(Boolean))].sort();
  uniSel.innerHTML = '<option value="all">All Sources</option>';
  orgs.forEach(org => {
    const opt = document.createElement('option');
    opt.value = org;
    opt.textContent = org;
    uniSel.appendChild(opt);
  });
}

function getFilteredProjects() {
  const query      = document.getElementById('searchInput').value.toLowerCase().trim();
  const country    = document.getElementById('filterCountry').value;
  const university = document.getElementById('filterUniversity').value;
  const category   = document.getElementById('filterCategory').value;
  const dismissed  = getDismissedIds();

  return allProjects.filter(p => {
    if (dismissed.includes(p.id)) return false;
    if (query) {
      const haystack = [
        p.title, p.description, p.source_org, p.contact_name, p.contact_email, p.country,
        ...(p.matched_keywords || []), ...(p.categories || [])
      ].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (country    !== 'all' && p.country    !== country)    return false;
    if (university !== 'all' && p.source_org !== university) return false;
    if (category   !== 'all' && !(p.categories || []).includes(category)) return false;
    return true;
  });
}

// ---- Render Projects ----
function renderProjects() {
  const container = document.getElementById('projectsContainer');
  const filtered  = getFilteredProjects();

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <img src="assets/berry_icon.png" alt="" class="empty-icon">
        <h3>${allProjects.length === 0 ? 'No projects yet' : 'No matching projects'}</h3>
        <p>${allProjects.length === 0
          ? 'The scraper has not run yet. Only active, thesis-qualifying projects will appear here after the next Monday scan.'
          : 'Try adjusting your search or filters.'}</p>
      </div>`;
    return;
  }

  const sorted = [...filtered].sort((a, b) => {
    const scoreA = a.relevance_score || 0;
    const scoreB = b.relevance_score || 0;
    if (scoreA !== scoreB) return scoreB - scoreA;
    return (b.first_seen || '').localeCompare(a.first_seen || '');
  });

  container.innerHTML = sorted.map((p, i) => {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const isNew   = p.first_seen && new Date(p.first_seen) > weekAgo;
    const score   = p.relevance_score || 0;

    return `
    <div class="project-card flagged" data-index="${i}">
      <button class="btn-dismiss" title="Dismiss this project" onclick="event.stopPropagation(); dismissProject('${esc(p.id)}')">&times;</button>
      <div class="project-inner" onclick="showDetail(${i})">
        <div class="project-relevance relevant" title="Relevance score: ${score}">${score}</div>
        <div class="project-body">
          <div class="project-header">
            <span class="project-title">${esc(p.title || 'Untitled Project')}</span>
            ${isNew ? '<span class="project-badge badge-new">NEW</span>' : ''}
            ${(p.categories || []).map(c => `<span class="project-badge badge-category">${esc(categoryLabel(c))}</span>`).join('')}
          </div>
          <div class="project-desc">${esc(p.description || 'No description available.')}</div>
          <div class="project-meta">
            <span>&#127891; ${esc(p.source_org || 'Unknown')}</span>
            <span>&#127758; ${esc(p.country || '—')}</span>
            ${p.contact_name  ? `<span>&#128100; ${esc(p.contact_name)}</span>`  : ''}
            ${p.contact_email ? `<span>&#9993; ${esc(p.contact_email)}</span>`   : ''}
            ${p.first_seen    ? `<span>&#128197; ${formatDate(p.first_seen)}</span>` : ''}
          </div>
        </div>
      </div>
    </div>`;
  }).join('');

  container._sortedData = sorted;

  const dismissedCount = getDismissedIds().length;
  const restoreBtn = document.getElementById('btnRestore');
  if (restoreBtn) {
    restoreBtn.style.display = dismissedCount > 0 ? '' : 'none';
    restoreBtn.textContent = `Restore dismissed (${dismissedCount})`;
  }
}

function showDetail(index) {
  const container = document.getElementById('projectsContainer');
  const sorted = container._sortedData || getFilteredProjects();
  const p = sorted[index];
  if (!p) return;

  document.getElementById('detailTitle').textContent = p.title || 'Untitled Project';
  document.getElementById('detailBody').innerHTML = `
    <div class="detail-section">
      <h3>Description</h3>
      <p>${esc(p.description || 'No description available.')}</p>
    </div>
    <div class="detail-section">
      <h3>Thesis Match (Score: ${p.relevance_score || 0})</h3>
      <div class="detail-tags">
        ${(p.categories || []).map(c => `<span class="detail-tag" style="background:rgba(0,122,110,0.1);color:var(--jade);">${esc(categoryLabel(c))}</span>`).join('')}
      </div>
      <div class="detail-tags" style="margin-top:8px;">
        ${(p.matched_keywords || []).map(k => `<span class="detail-tag">${esc(k)}</span>`).join('')}
      </div>
    </div>
    <div class="detail-section">
      <h3>Source</h3>
      <p>${esc(p.source_org || 'Unknown')} &mdash; ${esc(p.country || '—')}</p>
    </div>
    ${p.contact_name || p.contact_email ? `
    <div class="detail-section">
      <h3>Contact</h3>
      <div class="detail-contact">
        ${p.contact_name  ? `<strong>${esc(p.contact_name)}</strong><br>` : ''}
        ${p.contact_email ? `<a href="mailto:${esc(p.contact_email)}">${esc(p.contact_email)}</a>` : ''}
      </div>
    </div>` : ''}
    ${p.url ? `
    <div class="detail-section">
      <h3>Link</h3>
      <a href="${esc(p.url)}" target="_blank" rel="noopener" class="detail-link">
        Open original page &#8599;
      </a>
    </div>` : ''}
    <div class="detail-section" style="font-size:11px;color:var(--muted);">
      First seen: ${formatDate(p.first_seen)} | Last seen: ${formatDate(p.last_seen)} | Source: ${esc(p.source_name || '')}
    </div>
  `;
  toggleModal('detailModal', true);
}

// ---- Sources ----
let editingSourceIndex = -1;

function renderSources() {
  const list = document.getElementById('sourcesList');
  document.getElementById('sourceCount').textContent = `(${allSources.length})`;
  document.getElementById('statSources').textContent = allSources.length;

  if (allSources.length === 0) {
    list.innerHTML = '<p style="color:var(--muted);font-size:13px;">No URLs added yet.</p>';
    return;
  }

  list.innerHTML = allSources.map((s, i) => {
    if (i === editingSourceIndex) {
      return `
      <div class="source-item source-editing">
        <div class="source-edit-form">
          <div class="form-row">
            <input type="text" id="editName_${i}" value="${esc(s.name)}" placeholder="Label">
            <input type="url" id="editUrl_${i}" value="${esc(s.url)}" placeholder="URL">
            <input type="text" id="editCountry_${i}" value="${esc(s.country || '')}" placeholder="Country" style="max-width:140px;">
          </div>
          <div class="source-edit-actions">
            <button class="btn btn-primary btn-sm" onclick="saveSourceEdit(${i})">Save</button>
            <button class="btn btn-ghost btn-sm" onclick="cancelSourceEdit()">Cancel</button>
          </div>
        </div>
      </div>`;
    }
    return `
    <div class="source-item">
      <div class="source-info">
        <div class="source-name">${esc(s.name)}${s.country ? ` <span style="color:var(--muted);font-weight:normal;">— ${esc(s.country)}</span>` : ''}</div>
        <div class="source-url" title="${esc(s.url)}">${esc(s.url)}</div>
      </div>
      <div class="source-actions">
        <button class="btn btn-secondary btn-sm" onclick="startEditSource(${i})">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="removeSource(${i})">Remove</button>
      </div>
    </div>`;
  }).join('');
}

function startEditSource(index) {
  editingSourceIndex = index;
  renderSources();
}

function cancelSourceEdit() {
  editingSourceIndex = -1;
  renderSources();
}

async function saveSourceEdit(index) {
  const name    = document.getElementById(`editName_${index}`).value.trim();
  const url     = document.getElementById(`editUrl_${index}`).value.trim();
  const country = document.getElementById(`editCountry_${index}`).value.trim();

  if (!name || !url) {
    showToast('Label and URL are required.', 'error');
    return;
  }
  try { new URL(url); } catch {
    showToast('Please enter a valid URL.', 'error');
    return;
  }

  const updated = [...allSources];
  updated[index] = { name, url };
  if (country) updated[index].country = country;

  try {
    const file = await ghReadFile('sources.json');
    await ghWriteFile(
      'sources.json',
      JSON.stringify(updated, null, 2),
      `Edit source: ${name}`,
      file.sha
    );
    allSources = updated;
    editingSourceIndex = -1;
    renderSources();
    showToast('Source updated.', 'success');
  } catch (err) {
    showToast(`Could not save to GitHub: ${err.message}`, 'error');
  }
}

async function addSource() {
  const name    = document.getElementById('newSourceName').value.trim();
  const url     = document.getElementById('newSourceUrl').value.trim();
  const country = document.getElementById('newSourceCountry').value.trim();

  if (!name || !url) {
    showToast('Please enter both a label and URL.', 'error');
    return;
  }
  try { new URL(url); } catch {
    showToast('Please enter a valid URL.', 'error');
    return;
  }
  if (allSources.some(s => s.url === url)) {
    showToast('This URL is already in the list.', 'error');
    return;
  }

  const newSource = { name, url };
  if (country) newSource.country = country;
  const updated = [...allSources, newSource];

  try {
    const file = await ghReadFile('sources.json');
    await ghWriteFile(
      'sources.json',
      JSON.stringify(updated, null, 2),
      `Add source: ${name}`,
      file.sha
    );
    allSources = updated;
    showToast(`Added "${name}" — will be scraped on the next Monday scan.`, 'success');
  } catch (err) {
    showToast(`Could not save to GitHub: ${err.message}`, 'error');
    return;
  }

  renderSources();
  document.getElementById('newSourceName').value    = '';
  document.getElementById('newSourceUrl').value     = '';
  document.getElementById('newSourceCountry').value = '';
}

async function removeSource(index) {
  const source = allSources[index];
  if (!confirm(`Remove "${source.name}" from monitored URLs?`)) return;

  const updated = allSources.filter((_, i) => i !== index);

  try {
    const file = await ghReadFile('sources.json');
    await ghWriteFile(
      'sources.json',
      JSON.stringify(updated, null, 2),
      `Remove source: ${source.name}`,
      file.sha
    );
    allSources = updated;
    renderSources();
    showToast('URL removed.', 'success');
  } catch (err) {
    showToast(`Could not save to GitHub: ${err.message}`, 'error');
  }
}

// ---- Utilities ----
function toggleModal(id, show) {
  document.getElementById(id).classList.toggle('active', show);
  document.body.style.overflow = show ? 'hidden' : '';
}

function esc(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return dateStr; }
}

function categoryLabel(cat) {
  const labels = {
    semiconductors:    'Semiconductors',
    photonics:         'Photonics & Optics',
    advanced_materials:'Advanced Materials',
    equipment:         'Equipment & Metrology',
    quantum:           'Quantum'
  };
  return labels[cat] || cat;
}

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

// ---- Keywords Management ----
async function loadKeywords() {
  try {
    const res = await fetch(KEYWORDS_URL);
    if (!res.ok) throw new Error('No keywords');
    allKeywords = await res.json();
    renderKeywords();
    populateCategoryFilter();
  } catch {
    allKeywords = {};
  }
}

function populateCategoryFilter() {
  const sel = document.getElementById('filterCategory');
  sel.innerHTML = '<option value="all">All Categories</option>';
  Object.keys(allKeywords).forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = categoryLabel(cat);
    sel.appendChild(opt);
  });
}

function renderKeywords() {
  const container = document.getElementById('keywordCategories');
  if (!container) return;
  container.innerHTML = Object.keys(allKeywords).map(cat => {
    const label    = cat.replace(/_/g, ' ');
    const keywords = allKeywords[cat] || [];
    return `
    <div class="keyword-category" data-cat="${esc(cat)}">
      <div class="keyword-category-header">
        <h4>${esc(label)} (${keywords.length})</h4>
        <button class="btn-remove-cat" onclick="removeKeywordCategory('${esc(cat)}')">Remove category</button>
      </div>
      <div class="keyword-tags">
        ${keywords.map(kw => `
          <span class="keyword-tag">
            ${esc(kw)}
            <button class="tag-remove" onclick="removeKeyword('${esc(cat)}','${esc(kw)}')">&times;</button>
          </span>
        `).join('')}
      </div>
      <div class="keyword-add-row">
        <input type="text" placeholder="Add keyword..." id="kwInput_${esc(cat)}" onkeydown="if(event.key==='Enter')addKeyword('${esc(cat)}')">
        <button class="btn btn-primary btn-sm" onclick="addKeyword('${esc(cat)}')">Add</button>
      </div>
    </div>`;
  }).join('');
}

async function saveKeywords() {
  try {
    const file = await ghReadFile('keywords.json');
    await ghWriteFile(
      'keywords.json',
      JSON.stringify(allKeywords, null, 2),
      'Update thesis keywords via Radar UI',
      file.sha
    );
  } catch {
    // Silently fail — keywords still updated in memory for display
  }
}

function addKeyword(cat) {
  const input = document.getElementById(`kwInput_${cat}`);
  if (!input) return;
  const kw = input.value.trim().toLowerCase();
  if (!kw) return;
  if (!allKeywords[cat]) allKeywords[cat] = [];
  if (allKeywords[cat].includes(kw)) {
    showToast('Keyword already exists in this category.', 'error');
    return;
  }
  allKeywords[cat].push(kw);
  input.value = '';
  renderKeywords();
  saveKeywords();
  showToast(`Added "${kw}" to ${cat.replace(/_/g, ' ')}.`);
}

function removeKeyword(cat, kw) {
  if (!allKeywords[cat]) return;
  allKeywords[cat] = allKeywords[cat].filter(k => k !== kw);
  renderKeywords();
  saveKeywords();
  showToast(`Removed "${kw}" from ${cat.replace(/_/g, ' ')}.`);
}

function addKeywordCategory() {
  const input = document.getElementById('newCategoryName');
  const name  = input.value.trim().toLowerCase().replace(/\s+/g, '_');
  if (!name) return;
  if (allKeywords[name]) {
    showToast('Category already exists.', 'error');
    return;
  }
  allKeywords[name] = [];
  input.value = '';
  renderKeywords();
  saveKeywords();
  showToast(`Category "${name.replace(/_/g, ' ')}" created. Add keywords to it!`);
}

function removeKeywordCategory(cat) {
  if (!confirm(`Remove the entire "${cat.replace(/_/g, ' ')}" category and all its keywords?`)) return;
  delete allKeywords[cat];
  renderKeywords();
  saveKeywords();
  showToast(`Category "${cat.replace(/_/g, ' ')}" removed.`);
}

// ---- Scrape Now ----
async function triggerScrape() {
  const cfg = getGHConfig();
  if (!cfg) {
    showToast('Connect GitHub first (open Sources).', 'error');
    return;
  }

  const btn = document.getElementById('btnScrapeNow');
  btn.disabled = true;
  btn.textContent = 'Triggering...';

  try {
    const res = await fetch(
      `https://api.github.com/repos/${cfg.repo}/actions/workflows/scrape.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: cfg.branch }),
      }
    );
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`${res.status} ${errText}`);
    }
    showToast('Scrape triggered! Takes a few minutes. Refresh the page afterwards.');
  } catch (err) {
    showToast('Could not trigger scrape: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Scrape Now';
  }
}

function showToast(msg, type = 'success') {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}
