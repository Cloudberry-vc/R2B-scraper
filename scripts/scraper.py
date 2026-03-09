#!/usr/bin/env python3
"""
Cloudberry VC Research Radar — Weekly Scraper
Fetches research project pages from Nordic universities,
extracts ACTIVE project info, and only keeps projects that
qualify against the Cloudberry thesis.

Output: only thesis-relevant, active projects.
"""

import json
import re
import hashlib
import sys
import os
from datetime import datetime, timezone
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

# ──────────────────────────────────────────────
# CLOUDBERRY THESIS KEYWORDS
# Grouped by category for classification
# ──────────────────────────────────────────────

KEYWORD_MAP = {
    "semiconductors": [
        "semiconductor", "semiconductors", "silicon", "wafer", "chip", "chips",
        "integrated circuit", "ic design", "cmos", "mosfet", "transistor",
        "lithography", "etching", "doping", "epitaxy", "fab", "fabrication",
        "soc", "system-on-chip", "asic", "fpga", "mems", "nems",
        "gan", "gallium nitride", "sic", "silicon carbide", "gaas",
        "gallium arsenide", "inp", "indium phosphide", "wide bandgap",
        "compound semiconductor", "iii-v", "ii-vi", "power electronics",
        "rf devices", "microelectronics", "nanoelectronics", "packaging",
        "heterogeneous integration", "chiplet", "advanced packaging",
        "back-end-of-line", "front-end-of-line", "beol", "feol",
    ],
    "photonics": [
        "photonic", "photonics", "optical", "optics", "laser", "lasers",
        "led", "photodetector", "photodiode", "waveguide", "fiber optic",
        "fibre optic", "lidar", "silicon photonics", "integrated photonics",
        "photonic integrated circuit", "pic", "optical fiber", "optical sensor",
        "spectroscopy", "infrared", "ultraviolet", "uv", "visible light",
        "optical communication", "optical computing", "holograph",
        "diffractive", "refractive", "lens", "mirror", "grating",
        "modulator", "optical switch", "vcsel", "quantum dot laser",
        "terahertz", "thz",
    ],
    "advanced_materials": [
        "advanced material", "advanced materials", "nanomaterial",
        "nanomaterials", "thin film", "thin films", "coating", "coatings",
        "2d material", "graphene", "boron nitride", "mos2", "transition metal",
        "perovskite", "ceramic", "ceramics", "composite", "composites",
        "metamaterial", "polymer", "functional material", "smart material",
        "superconductor", "superconducting", "piezoelectric", "ferroelectric",
        "magnetic material", "spintronics", "topological", "biomaterial",
        "crystal growth", "single crystal", "polycrystalline", "amorphous",
        "nanoparticle", "nanostructure", "nanofiber", "nanotube",
        "carbon nanotube", "cnt", "quantum dot", "colloidal",
    ],
    "equipment": [
        "equipment", "metrology", "inspection", "deposition", "sputtering",
        "evaporation", "ald", "atomic layer deposition", "cvd",
        "chemical vapor deposition", "pvd", "physical vapor deposition",
        "ion beam", "plasma", "etch", "clean room", "cleanroom",
        "characterization", "microscopy", "sem", "tem", "afm",
        "scanning electron", "transmission electron", "atomic force",
        "x-ray diffraction", "xrd", "raman", "ellipsometry",
        "profilometry", "interferometry", "mass spectrometry",
        "spectrometer", "detector", "sensor fabrication",
        "process control", "yield management", "wafer inspection",
    ],
    "quantum": [
        "quantum", "qubit", "quantum computing", "quantum computer",
        "quantum sensing", "quantum communication", "quantum cryptography",
        "quantum key distribution", "qkd", "quantum network",
        "quantum simulation", "quantum algorithm", "quantum error",
        "quantum entanglement", "quantum coherence", "quantum dot",
        "superconducting qubit", "trapped ion", "topological qubit",
        "quantum photonic", "quantum advantage", "nisq",
    ],
}

# Minimum keyword matches required for a project to qualify.
# A single generic hit (e.g. "silicon" in a biology context) is not enough.
MIN_KEYWORD_HITS = 2          # at least 2 distinct keyword matches
MIN_CATEGORIES   = 1          # across at least 1 category

# ──────────────────────────────────────────────
# ACTIVE PROJECT DETECTION
# Words/phrases that signal a project is finished, cancelled, or archived
# ──────────────────────────────────────────────

INACTIVE_SIGNALS = re.compile(
    r'\b('
    r'completed|finished|ended|closed|archived|concluded|terminated|'
    r'päättynyt|avslutad|afsluttet|'           # Finnish / Swedish / Danish
    r'final report|slutrapport|loppuraportti'
    r')\b',
    re.IGNORECASE
)

# Date patterns: "01/2020 – 12/2023" or "2019-01-01 to 2022-12-31" etc.
DATE_RANGE_RE = re.compile(
    r'(\d{1,2}[/.-]\d{4}|\d{4}[/.-]\d{1,2}(?:[/.-]\d{1,2})?)'
    r'\s*[\u2013\u2014\-–—to]+\s*'
    r'(\d{1,2}[/.-]\d{4}|\d{4}[/.-]\d{1,2}(?:[/.-]\d{1,2})?)'
)

# Explicit "Status: Active" / "Status: Ongoing" patterns
ACTIVE_SIGNALS = re.compile(
    r'\b(active|ongoing|running|in progress|current|käynnissä|pågående|igangværende)\b',
    re.IGNORECASE
)


def _parse_fuzzy_date(s):
    """Try to extract a year from a fuzzy date string."""
    for fmt in ('%Y-%m-%d', '%d/%m/%Y', '%m/%Y', '%Y-%m', '%d.%m.%Y', '%m.%Y', '%Y'):
        try:
            return datetime.strptime(s.strip(), fmt)
        except ValueError:
            continue
    # Last resort: just grab a 4-digit year
    m = re.search(r'(20\d{2})', s)
    if m:
        return datetime(int(m.group(1)), 12, 31)
    return None


def is_project_active(title, description, detail_text=''):
    """
    Determine whether a project appears to be active/ongoing.
    Returns (is_active: bool, status_hint: str).

    Logic:
    1. If there's an explicit "Status: Active/Ongoing" → active
    2. If there's an explicit "completed/finished/ended" → inactive
    3. If there's an end date in the past → inactive
    4. If there's an end date in the future or no end date → active (benefit of doubt)
    """
    combined = f"{title} {description} {detail_text}"

    # Check explicit active signals
    if ACTIVE_SIGNALS.search(combined):
        return True, 'active_signal'

    # Check explicit inactive signals
    if INACTIVE_SIGNALS.search(combined):
        return False, 'inactive_signal'

    # Check date ranges
    now = datetime.now()
    date_matches = DATE_RANGE_RE.findall(combined)
    for start_str, end_str in date_matches:
        end_date = _parse_fuzzy_date(end_str)
        if end_date and end_date < now:
            return False, f'ended_{end_str}'

    # No strong signal either way → assume active
    return True, 'assumed_active'


# Compile all keywords into regex patterns per category
CATEGORY_PATTERNS = {}
for cat, keywords in KEYWORD_MAP.items():
    escaped = [re.escape(kw) for kw in keywords]
    pattern = re.compile(r'\b(' + '|'.join(escaped) + r')\b', re.IGNORECASE)
    CATEGORY_PATTERNS[cat] = (pattern, keywords)

# ──────────────────────────────────────────────
# SCRAPING
# ──────────────────────────────────────────────

HEADERS = {
    'User-Agent': 'CloudberryVC-ResearchRadar/1.0 (research monitoring; contact: rene@cloudberry.vc)',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'en,fi,sv,da;q=0.9',
}

def fetch_page(url, timeout=30):
    """Fetch a URL and return BeautifulSoup object."""
    try:
        resp = requests.get(url, headers=HEADERS, timeout=timeout, allow_redirects=True)
        resp.raise_for_status()
        return BeautifulSoup(resp.text, 'html.parser')
    except Exception as e:
        print(f"  [WARN] Failed to fetch {url}: {e}")
        return None


def extract_projects_generic(soup, base_url, source):
    """
    Generic project extractor. Looks for structured project listings
    in common patterns used by university research portals.
    """
    projects = []

    # Strategy 1: Pure/CRIS portal listings (used by many Nordic unis)
    for container in soup.select('.result-container .list-result-item, .rendering, .result-container li'):
        title_el = container.select_one('h3 a, h2 a, .result-title a, a.link')
        if not title_el:
            continue
        title = title_el.get_text(strip=True)
        link = urljoin(base_url, title_el.get('href', ''))
        desc = ''
        desc_el = container.select_one('.result-description, .rendering-description, p')
        if desc_el:
            desc = desc_el.get_text(strip=True)[:500]

        # Try to find date/status info
        date_el = container.select_one('.date, .period, .result-date, time')
        date_text = date_el.get_text(strip=True) if date_el else ''

        # Status badge (some portals have "Active" / "Finished" labels)
        status_el = container.select_one('.status, .badge, .label, .project-status')
        status_text = status_el.get_text(strip=True) if status_el else ''

        person_el = container.select_one('.person-list a, .result-persons a, .author a')
        contact_name = person_el.get_text(strip=True) if person_el else ''

        projects.append({
            'title': title,
            'description': desc,
            'url': link,
            'contact_name': contact_name,
            'contact_email': '',
            '_date_text': date_text,
            '_status_text': status_text,
        })

    # Strategy 2: Card/grid layouts
    if not projects:
        for card in soup.select('.card, .project-card, .item, article.post, .view-content .views-row'):
            title_el = card.select_one('h2 a, h3 a, .card-title a, .title a, a.card-link')
            if not title_el:
                title_el = card.select_one('h2, h3, .card-title, .title')
            if not title_el:
                continue
            title = title_el.get_text(strip=True)
            link_el = title_el if title_el.name == 'a' else card.select_one('a')
            link = urljoin(base_url, link_el.get('href', '')) if link_el else base_url
            desc_el = card.select_one('p, .description, .card-text, .summary, .field-content')
            desc = desc_el.get_text(strip=True)[:500] if desc_el else ''

            date_el = card.select_one('.date, .period, time, .meta')
            date_text = date_el.get_text(strip=True) if date_el else ''

            projects.append({
                'title': title,
                'description': desc,
                'url': link,
                'contact_name': '',
                'contact_email': '',
                '_date_text': date_text,
                '_status_text': '',
            })

    # Strategy 3: Link-based fallback
    if not projects:
        seen_titles = set()
        for link_el in soup.select('main a, .content a, #content a'):
            href = link_el.get('href', '')
            text = link_el.get_text(strip=True)
            if len(text) > 10 and len(text) < 200 and text not in seen_titles:
                if any(kw in href.lower() for kw in ['project', 'research', 'tutkimus', 'hanke', 'forskning', 'projekt']):
                    seen_titles.add(text)
                    projects.append({
                        'title': text,
                        'description': '',
                        'url': urljoin(base_url, href),
                        'contact_name': '',
                        'contact_email': '',
                        '_date_text': '',
                        '_status_text': '',
                    })

    return projects


def fetch_detail_page(url):
    """Fetch a project detail page and return full text + contact info."""
    soup = fetch_page(url)
    if not soup:
        return '', '', ''

    # Full text for active/relevance checking
    main_el = soup.select_one('main, #content, .content, article')
    full_text = main_el.get_text(' ', strip=True)[:3000] if main_el else soup.get_text(' ', strip=True)[:3000]

    # Extract email
    email = ''
    email_links = soup.select('a[href^="mailto:"]')
    if email_links:
        email = email_links[0].get('href', '').replace('mailto:', '').split('?')[0]

    # Extract contact name
    name = ''
    for el in soup.select('.person-name, .contact-name, .author, .researcher-name, .pi-name'):
        name = el.get_text(strip=True)
        if name:
            break

    return full_text, name, email


# ──────────────────────────────────────────────
# CLASSIFICATION
# ──────────────────────────────────────────────

def classify_project(title, description, detail_text=''):
    """
    Classify a project against the Cloudberry thesis keywords.
    Uses title + description + detail page text.

    Requires at least MIN_KEYWORD_HITS distinct keyword matches
    to qualify. This avoids false positives from a single generic
    word like "silicon" in an unrelated biology paper.

    Returns (qualifies, categories, matched_keywords, score).
    """
    text = f"{title} {description} {detail_text}".lower()

    categories = []
    matched_keywords = []

    for cat, (pattern, keywords) in CATEGORY_PATTERNS.items():
        matches = pattern.findall(text)
        if matches:
            unique_matches = list(set(m.lower() for m in matches))
            categories.append(cat)
            matched_keywords.extend(unique_matches)

    unique_keywords = list(set(matched_keywords))
    score = len(unique_keywords)

    qualifies = (
        len(categories) >= MIN_CATEGORIES
        and score >= MIN_KEYWORD_HITS
    )

    return qualifies, categories, unique_keywords, score


def make_id(title, url):
    """Generate a stable ID for deduplication."""
    raw = f"{title.lower().strip()}|{url.lower().strip()}"
    return hashlib.md5(raw.encode()).hexdigest()[:12]


# ──────────────────────────────────────────────
# MAIN
# ──────────────────────────────────────────────

def main():
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    sources_path = os.path.join(repo_root, 'sources.json')
    data_path = os.path.join(repo_root, 'data', 'projects.json')

    with open(sources_path, 'r') as f:
        sources = json.load(f)

    # Load existing projects for dedup and history
    existing_projects = {}
    try:
        with open(data_path, 'r') as f:
            data = json.load(f)
            for p in data.get('projects', []):
                existing_projects[p.get('id', '')] = p
    except (FileNotFoundError, json.JSONDecodeError):
        pass

    now = datetime.now(timezone.utc).isoformat()
    stats = {'new': 0, 'updated': 0, 'skipped_inactive': 0, 'skipped_irrelevant': 0}

    print(f"=== Cloudberry Research Radar Scraper ===")
    print(f"Time: {now}")
    print(f"Sources: {len(sources)}")
    print(f"Qualification: min {MIN_KEYWORD_HITS} keyword hits, min {MIN_CATEGORIES} category")
    print()

    for source in sources:
        print(f"[SCRAPING] {source['name']}")
        print(f"  URL: {source['url']}")

        soup = fetch_page(source['url'])
        if not soup:
            continue

        raw_projects = extract_projects_generic(soup, source['url'], source)
        print(f"  Found {len(raw_projects)} raw project(s)")

        for raw in raw_projects:
            pid = make_id(raw['title'], raw['url'])

            # ── Step 1: Quick relevance pre-check on title+description ──
            quick_qualifies, _, _, quick_score = classify_project(
                raw['title'], raw.get('description', '')
            )

            # If zero keyword hits from title+desc, skip entirely (no detail fetch)
            if quick_score == 0:
                stats['skipped_irrelevant'] += 1
                continue

            # ── Step 2: Fetch detail page for borderline/qualifying projects ──
            detail_text = ''
            contact_name = raw.get('contact_name', '')
            contact_email = raw.get('contact_email', '')

            if raw.get('url') and raw['url'] != source['url']:
                detail_text, det_name, det_email = fetch_detail_page(raw['url'])
                if det_name and not contact_name:
                    contact_name = det_name
                if det_email and not contact_email:
                    contact_email = det_email

            # ── Step 3: Full classification with detail text ──
            qualifies, categories, matched_kw, score = classify_project(
                raw['title'], raw.get('description', ''), detail_text
            )

            if not qualifies:
                stats['skipped_irrelevant'] += 1
                continue

            # ── Step 4: Active check ──
            combined_status = f"{raw.get('_date_text', '')} {raw.get('_status_text', '')}"
            active, status_hint = is_project_active(
                raw['title'], raw.get('description', ''),
                f"{combined_status} {detail_text}"
            )

            if not active:
                stats['skipped_inactive'] += 1
                print(f"  ✗ INACTIVE: {raw['title'][:60]}... ({status_hint})")
                # If it was previously tracked, mark it inactive but keep it
                if pid in existing_projects:
                    existing_projects[pid]['status'] = 'inactive'
                    existing_projects[pid]['last_seen'] = now
                continue

            # ── Step 5: Store qualifying, active project ──
            if pid in existing_projects:
                existing = existing_projects[pid]
                existing['last_seen'] = now
                existing['status'] = 'active'
                existing['categories'] = categories
                existing['matched_keywords'] = matched_kw
                existing['relevance_score'] = score
                if contact_name and not existing.get('contact_name'):
                    existing['contact_name'] = contact_name
                if contact_email and not existing.get('contact_email'):
                    existing['contact_email'] = contact_email
                stats['updated'] += 1
            else:
                existing_projects[pid] = {
                    'id': pid,
                    'title': raw['title'],
                    'description': raw.get('description', ''),
                    'url': raw.get('url', ''),
                    'source_name': source['name'],
                    'source_org': source.get('organization', source['name']),
                    'country': source.get('country', 'Finland'),
                    'contact_name': contact_name,
                    'contact_email': contact_email,
                    'is_relevant': True,
                    'status': 'active',
                    'categories': categories,
                    'matched_keywords': matched_kw,
                    'relevance_score': score,
                    'first_seen': now,
                    'last_seen': now,
                }
                stats['new'] += 1
                print(f"  ★ NEW: {raw['title'][:60]}... [{', '.join(categories)}] (score: {score})")

        print()

    # ── Build output: only active, qualifying projects ──
    active_projects = [
        p for p in existing_projects.values()
        if p.get('status', 'active') == 'active' and p.get('is_relevant', False)
    ]

    # Sort by relevance score (highest first), then newest
    active_projects.sort(key=lambda p: (-p.get('relevance_score', 0), p.get('first_seen', '')))

    os.makedirs(os.path.dirname(data_path), exist_ok=True)
    output = {
        'last_updated': now,
        'total': len(active_projects),
        'by_category': {
            cat: sum(1 for p in active_projects if cat in p.get('categories', []))
            for cat in KEYWORD_MAP
        },
        'by_country': {},
        'projects': active_projects,
    }

    # Count by country
    for p in active_projects:
        c = p.get('country', 'Unknown')
        output['by_country'][c] = output['by_country'].get(c, 0) + 1

    with open(data_path, 'w') as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"=== Done ===")
    print(f"Active, qualifying projects: {len(active_projects)}")
    print(f"New this run: {stats['new']}")
    print(f"Updated: {stats['updated']}")
    print(f"Skipped (not relevant): {stats['skipped_irrelevant']}")
    print(f"Skipped (inactive/ended): {stats['skipped_inactive']}")
    print(f"")
    print(f"By category:")
    for cat, count in output['by_category'].items():
        print(f"  {cat}: {count}")
    print(f"By country:")
    for country, count in output['by_country'].items():
        print(f"  {country}: {count}")


if __name__ == '__main__':
    main()
