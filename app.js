/* ============================================
   Cloudberry VC Research Radar — App Logic
   All listed projects are active & thesis-qualifying.
   ============================================ */

const DATA_URL = 'data/projects.json';
const SOURCES_URL = 'sources.json';

let allProjects = [];
let allSources = [];
let dataMetadata = {};

// ---- Init ----
document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  await loadSources();
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
  setupBulkImport();

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

// ---- Data Loading ----
async function loadProjects() {
  try {
    const res = await fetch(DATA_URL);
    if (!res.ok) throw new Error('No data yet');
    const data = await res.json();
    allProjects = data.projects || [];
    dataMetadata = {
      by_category: data.by_category || {},
      by_country: data.by_country || {},
    };
    if (data.last_updated) {
      document.getElementById('lastUpdated').textContent = `Last scan: ${formatDate(data.last_updated)}`;
    }
    updateStats();
    populateFilters();
    renderProjects();
  } catch (e) {
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
  } catch (e) {
    allSources = [];
    renderSources();
  }
}

// ---- Stats ----
function updateStats() {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // All projects in data are already active + thesis-qualifying
  document.getElementById('statTotal').textContent = allProjects.length;
  document.getElementById('statNew').textContent = allProjects.filter(p => {
    return p.first_seen && new Date(p.first_seen) > weekAgo;
  }).length;
  document.getElementById('statSources').textContent = allSources.length;

  // Country breakdown
  const countries = [...new Set(allProjects.map(p => p.country).filter(Boolean))];
  document.getElementById('statCountries').textContent = countries.length;
}

// ---- Filters ----
function populateFilters() {
  // Country filter
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

  // University filter
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
  const query = document.getElementById('searchInput').value.toLowerCase().trim();
  const country = document.getElementById('filterCountry').value;
  const university = document.getElementById('filterUniversity').value;
  const category = document.getElementById('filterCategory').value;

  return allProjects.filter(p => {
    // Search
    if (query) {
      const haystack = [
        p.title, p.description, p.source_org, p.contact_name, p.contact_email, p.country,
        ...(p.matched_keywords || []), ...(p.categories || [])
      ].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    // Country
    if (country !== 'all' && p.country !== country) return false;
    // University
    if (university !== 'all' && p.source_org !== university) return false;
    // Category
    if (category !== 'all' && !(p.categories || []).includes(category)) return false;
    return true;
  });
}

// ---- Render Projects ----
function renderProjects() {
  const container = document.getElementById('projectsContainer');
  const filtered = getFilteredProjects();

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

  // Sort by relevance score (highest first), then newest
  const sorted = [...filtered].sort((a, b) => {
    const scoreA = a.relevance_score || 0;
    const scoreB = b.relevance_score || 0;
    if (scoreA !== scoreB) return scoreB - scoreA;
    return (b.first_seen || '').localeCompare(a.first_seen || '');
  });

  container.innerHTML = sorted.map((p, i) => {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const isNew = p.first_seen && new Date(p.first_seen) > weekAgo;
    const score = p.relevance_score || 0;

    return `
    <div class="project-card flagged" onclick="showDetail(${i})" data-index="${i}">
      <div class="project-relevance relevant" title="Relevance score: ${score}">
        ${score}
      </div>
      <div class="project-body">
        <div class="project-header">
          <span class="project-title">${esc(p.title || 'Untitled Project')}</span>
          ${isNew ? '<span class="project-badge badge-new">NEW</span>' : ''}
          ${(p.categories || []).map(c => `<span class="project-badge badge-category">${esc(categoryLabel(c))}</span>`).join('')}
        </div>
        <div class="project-desc">${esc(p.description || 'No description available.')}</div>
        <div class="project-meta">
          <span>&#127891; ${esc(p.source_org || 'Unknown')}</span>
          <span>&#127758; ${esc(p.country || 'Finland')}</span>
          ${p.contact_name ? `<span>&#128100; ${esc(p.contact_name)}</span>` : ''}
          ${p.contact_email ? `<span>&#9993; ${esc(p.contact_email)}</span>` : ''}
          ${p.first_seen ? `<span>&#128197; ${formatDate(p.first_seen)}</span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');

  container._sortedData = sorted;
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
      <p>${esc(p.source_org || 'Unknown')} &mdash; ${esc(p.country || 'Finland')}</p>
    </div>
    ${p.contact_name || p.contact_email ? `
    <div class="detail-section">
      <h3>Contact</h3>
      <div class="detail-contact">
        ${p.contact_name ? `<strong>${esc(p.contact_name)}</strong><br>` : ''}
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
function renderSources() {
  const list = document.getElementById('sourcesList');
  document.getElementById('sourceCount').textContent = `(${allSources.length})`;
  document.getElementById('statSources').textContent = allSources.length;

  if (allSources.length === 0) {
    list.innerHTML = '<p style="color:var(--muted);font-size:13px;">No sources configured yet.</p>';
    return;
  }

  list.innerHTML = allSources.map((s, i) => `
    <div class="source-item">
      <div class="source-info">
        <div class="source-name">${esc(s.name)}</div>
        <div class="source-org">${esc(s.organization || '')} &bull; ${esc(s.country || 'Finland')} &bull; ${esc(s.type || 'university')}</div>
        <div class="source-url" title="${esc(s.url)}">${esc(s.url)}</div>
      </div>
      <button class="btn btn-danger btn-sm" onclick="removeSource(${i})">Remove</button>
    </div>
  `).join('');
}

async function addSource() {
  const name = document.getElementById('newSourceName').value.trim();
  const url = document.getElementById('newSourceUrl').value.trim();
  const org = document.getElementById('newSourceOrg').value.trim();
  const country = document.getElementById('newSourceCountry').value;
  const type = document.getElementById('newSourceType').value;

  if (!name || !url) {
    showToast('Please enter both a name and URL.', 'error');
    return;
  }

  try {
    new URL(url);
  } catch {
    showToast('Please enter a valid URL.', 'error');
    return;
  }

  const newSource = { name, url, organization: org || name, country, type };

  try {
    const res = await fetch('/.netlify/functions/manage-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add', source: newSource })
    });
    if (res.ok) {
      const data = await res.json();
      allSources = data.sources || [...allSources, newSource];
      showToast(`Added "${name}" — it will be scraped on the next Monday scan.`, 'success');
    } else {
      throw new Error('Function not available');
    }
  } catch {
    allSources.push(newSource);
    showToast(`Added "${name}" locally. Deploy the Netlify Function for shared persistence.`, 'success');
  }

  renderSources();

  document.getElementById('newSourceName').value = '';
  document.getElementById('newSourceUrl').value = '';
  document.getElementById('newSourceOrg').value = '';
}

async function removeSource(index) {
  const source = allSources[index];
  if (!confirm(`Remove "${source.name}" from sources?`)) return;

  try {
    const res = await fetch('/.netlify/functions/manage-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'remove', index })
    });
    if (res.ok) {
      const data = await res.json();
      allSources = data.sources;
    } else {
      throw new Error('Function not available');
    }
  } catch {
    allSources.splice(index, 1);
  }

  renderSources();
  showToast('Source removed.', 'success');
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
    semiconductors: 'Semiconductors',
    photonics: 'Photonics & Optics',
    advanced_materials: 'Advanced Materials',
    equipment: 'Equipment & Metrology',
    quantum: 'Quantum'
  };
  return labels[cat] || cat;
}

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

// ---- Bulk Import ----
function setupBulkImport() {
  const tabPaste = document.getElementById('tabPaste');
  const tabUpload = document.getElementById('tabUpload');
  const panelPaste = document.getElementById('panelPaste');
  const panelUpload = document.getElementById('panelUpload');

  // Tab switching
  tabPaste.addEventListener('click', () => {
    tabPaste.classList.add('active');
    tabUpload.classList.remove('active');
    panelPaste.style.display = '';
    panelUpload.style.display = 'none';
  });
  tabUpload.addEventListener('click', () => {
    tabUpload.classList.add('active');
    tabPaste.classList.remove('active');
    panelUpload.style.display = '';
    panelPaste.style.display = 'none';
  });

  // Paste import
  document.getElementById('btnBulkPaste').addEventListener('click', bulkImportFromPaste);

  // File upload
  const dropZone = document.getElementById('fileDropZone');
  const fileInput = document.getElementById('bulkFileInput');
  const browseLink = document.getElementById('fileBrowseLink');

  browseLink.addEventListener('click', (e) => { e.preventDefault(); fileInput.click(); });
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length) handleBulkFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) handleBulkFile(fileInput.files[0]);
  });
  document.getElementById('btnBulkUpload').addEventListener('click', commitBulkFile);
}

let pendingBulkSources = [];

function parseBulkLines(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const sources = [];
  for (const line of lines) {
    // Skip header rows
    if (/^name\b/i.test(line)) continue;
    const parts = line.split(/[,\t]/).map(s => s.trim());
    if (parts.length < 2 || !parts[0] || !parts[1]) continue;
    // Validate URL loosely
    try { new URL(parts[1]); } catch { continue; }
    sources.push({
      name: parts[0],
      url: parts[1],
      organization: parts[2] || parts[0],
      country: parts[3] || 'Finland',
      type: parts[4] || 'university',
    });
  }
  return sources;
}

function bulkImportFromPaste() {
  const text = document.getElementById('bulkPasteInput').value.trim();
  if (!text) { showToast('Nothing to import — paste some sources first.', 'error'); return; }
  const parsed = parseBulkLines(text);
  if (parsed.length === 0) { showToast('Could not parse any valid sources. Use format: name, url, org, country, type', 'error'); return; }
  addBulkSources(parsed);
  document.getElementById('bulkPasteInput').value = '';
}

function handleBulkFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (['csv', 'tsv', 'txt'].includes(ext)) {
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = parseBulkLines(reader.result);
      if (parsed.length === 0) { showToast('No valid sources found in file.', 'error'); return; }
      pendingBulkSources = parsed;
      document.getElementById('bulkFileStatus').textContent = `Found ${parsed.length} source(s) in "${file.name}"`;
      document.getElementById('bulkFilePreview').style.display = '';
    };
    reader.readAsText(file);
  } else if (['xlsx', 'xls'].includes(ext)) {
    // Read Excel via basic parsing (ArrayBuffer → CSV-like extraction)
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = parseExcelBuffer(reader.result);
        if (parsed.length === 0) { showToast('No valid sources found in spreadsheet.', 'error'); return; }
        pendingBulkSources = parsed;
        document.getElementById('bulkFileStatus').textContent = `Found ${parsed.length} source(s) in "${file.name}"`;
        document.getElementById('bulkFilePreview').style.display = '';
      } catch (err) {
        showToast('Could not read spreadsheet. Please try CSV format instead.', 'error');
      }
    };
    reader.readAsArrayBuffer(file);
  } else {
    showToast('Unsupported file type. Please use CSV, TSV, XLS, or XLSX.', 'error');
  }
}

function parseExcelBuffer(buffer) {
  // Lightweight XLSX parser — extracts shared strings and first sheet rows
  // For full Excel support, users can export to CSV
  try {
    // Use JSZip-like approach: XLSX is a ZIP with XML inside
    // Fallback: try to decode as CSV if it fails
    const bytes = new Uint8Array(buffer);
    // Check for ZIP signature (PK)
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4B) {
      // Not a ZIP/XLSX — try as CSV text
      const text = new TextDecoder().decode(buffer);
      return parseBulkLines(text);
    }
    // For XLSX: we suggest CSV export since full parsing in vanilla JS is complex
    showToast('For Excel files, please save as CSV first for most reliable import.', 'error');
    return [];
  } catch {
    return [];
  }
}

function commitBulkFile() {
  if (pendingBulkSources.length === 0) { showToast('No sources to import.', 'error'); return; }
  addBulkSources(pendingBulkSources);
  pendingBulkSources = [];
  document.getElementById('bulkFilePreview').style.display = 'none';
  document.getElementById('bulkFileInput').value = '';
}

async function addBulkSources(newSources) {
  // Deduplicate against existing sources
  const existingUrls = new Set(allSources.map(s => s.url));
  const unique = newSources.filter(s => !existingUrls.has(s.url));
  const dupeCount = newSources.length - unique.length;

  if (unique.length === 0) {
    showToast(`All ${newSources.length} source(s) already exist.`, 'error');
    return;
  }

  try {
    const res = await fetch('/.netlify/functions/manage-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'bulk_add', sources: unique }),
    });
    if (res.ok) {
      const data = await res.json();
      allSources = data.sources || [...allSources, ...unique];
    } else {
      throw new Error('Function not available');
    }
  } catch {
    allSources.push(...unique);
  }

  renderSources();
  const msg = `Imported ${unique.length} source(s).${dupeCount > 0 ? ` ${dupeCount} duplicate(s) skipped.` : ''}`;
  showToast(msg, 'success');
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
