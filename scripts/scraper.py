#!/usr/bin/env python3
"""
Cloudberry VC Research Radar — Weekly Scraper

Fetches research project pages from user-supplied URLs,
extracts project info using multiple flexible strategies,
classifies against the Cloudberry thesis keywords, and
keeps only active, qualifying projects.

Incremental: skips detail-page fetches for projects already in the database.
Only new (unseen) projects get their detail pages fetched and classified.

Output: data/projects.json — active, thesis-relevant projects only.
"""

import json
import re
import hashlib
import sys
import os
from datetime import datetime, timezone
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup, Tag

# ──────────────────────────────────────────────
# CLOUDBERRY THESIS KEYWORDS
# ──────────────────────────────────────────────

KEYWORDS_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'keywords.json')

def load_keywords():
    try:
        with open(KEYWORDS_FILE, 'r') as f:
            return json.load(f)
    except Exception as e:
        print(f"[ERROR] Could not load keywords.json: {e}")
        sys.exit(1)

KEYWORD_MAP = load_keywords()

MIN_KEYWORD_HITS = 2
MIN_CATEGORIES   = 1

# Compile keyword patterns
CATEGORY_PATTERNS = {}
for cat, keywords in KEYWORD_MAP.items():
    escaped = [re.escape(kw) for kw in keywords]
    pattern = re.compile(r'\b(' + '|'.join(escaped) + r')\b', re.IGNORECASE)
    CATEGORY_PATTERNS[cat] = (pattern, keywords)

# ──────────────────────────────────────────────
# ACTIVE PROJECT DETECTION
# ──────────────────────────────────────────────

INACTIVE_SIGNALS = re.compile(
    r'\b('
    r'completed|finished|ended|closed|archived|concluded|terminated|'
    r'päättynyt|avslutad|afsluttet|'
    r'final report|slutrapport|loppuraportti'
    r')\b',
    re.IGNORECASE
)

DATE_RANGE_RE = re.compile(
    r'(\d{1,2}[/.-]\d{4}|\d{4}[/.-]\d{1,2}(?:[/.-]\d{1,2})?)'
    r'\s*[\u2013\u2014\-–—to]+\s*'
    r'(\d{1,2}[/.-]\d{4}|\d{4}[/.-]\d{1,2}(?:[/.-]\d{1,2})?)'
)

ACTIVE_SIGNALS = re.compile(
    r'\b(active|ongoing|running|in progress|current|käynnissä|pågående|igangværende)\b',
    re.IGNORECASE
)


def _parse_fuzzy_date(s):
    for fmt in ('%Y-%m-%d', '%d/%m/%Y', '%m/%Y', '%Y-%m', '%d.%m.%Y', '%m.%Y', '%Y'):
        try:
            return datetime.strptime(s.strip(), fmt)
        except ValueError:
            continue
    m = re.search(r'(20\d{2})', s)
    if m:
        return datetime(int(m.group(1)), 12, 31)
    return None


def is_project_active(title, description, detail_text=''):
    combined = f"{title} {description} {detail_text}"
    if ACTIVE_SIGNALS.search(combined):
        return True, 'active_signal'
    if INACTIVE_SIGNALS.search(combined):
        return False, 'inactive_signal'
    now = datetime.now()
    for start_str, end_str in DATE_RANGE_RE.findall(combined):
        end_date = _parse_fuzzy_date(end_str)
        if end_date and end_date < now:
            return False, f'ended_{end_str}'
    return True, 'assumed_active'


# ──────────────────────────────────────────────
# HTTP
# ──────────────────────────────────────────────

HEADERS = {
    'User-Agent': 'CloudberryVC-ResearchRadar/1.0 (research monitoring; contact: rene@cloudberry.vc)',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'en,fi,sv,da;q=0.9',
}

SKIP_HREF_PATTERNS = [
    'login', 'sign-in', 'cookie', 'privacy', 'contact-us', 'terms',
    'facebook', 'twitter', 'linkedin', 'instagram', 'youtube',
    '.jpg', '.png', '.gif', '.svg', '.pdf', '.css', '.js',
    '#', 'javascript:', 'mailto:', 'tel:',
]


def fetch_page(url, timeout=30):
    try:
        resp = requests.get(url, headers=HEADERS, timeout=timeout, allow_redirects=True)
        resp.raise_for_status()
        return BeautifulSoup(resp.text, 'html.parser')
    except Exception as e:
        print(f"  [WARN] Failed to fetch {url}: {e}")
        return None


def _is_skip_link(href):
    href_lower = href.lower()
    return any(s in href_lower for s in SKIP_HREF_PATTERNS)


def _find_nearest_text(el, selector_hints, max_chars=500):
    for hint in selector_hints:
        found = el.select_one(hint) if isinstance(el, Tag) else None
        if found:
            txt = found.get_text(strip=True)[:max_chars]
            if len(txt) > 20:
                return txt
    for p in (el.select('p') if isinstance(el, Tag) else []):
        txt = p.get_text(strip=True)[:max_chars]
        if len(txt) > 20:
            return txt
    return ''


def _find_date_text(el):
    if not isinstance(el, Tag):
        return ''
    for sel in ['.date', '.period', 'time', '.meta', '.result-date',
                '[class*="date"]', '[class*="period"]', '[class*="time"]']:
        found = el.select_one(sel)
        if found:
            return found.get_text(strip=True)
    return ''


def _find_status_text(el):
    if not isinstance(el, Tag):
        return ''
    for sel in ['.status', '.badge', '.label', '.project-status', '.tag',
                '[class*="status"]', '[class*="badge"]']:
        found = el.select_one(sel)
        if found:
            return found.get_text(strip=True)
    return ''


def _find_contact(el):
    if not isinstance(el, Tag):
        return ''
    for sel in ['.person-list a', '.result-persons a', '.author a', '.author',
                '.person-name', '.contact-name', '.researcher-name', '.pi-name',
                '[class*="person"]', '[class*="author"]', '[class*="contact"]']:
        found = el.select_one(sel)
        if found:
            txt = found.get_text(strip=True)
            if txt and len(txt) > 2:
                return txt
    return ''


DESC_HINTS = [
    '.result-description', '.rendering-description', '.description',
    '.card-text', '.summary', '.field-content', '.excerpt', '.teaser',
    '.abstract', '.intro', '[class*="desc"]', '[class*="summary"]',
    '[class*="abstract"]', '[class*="excerpt"]',
]


# ──────────────────────────────────────────────
# PROJECT EXTRACTION — multiple strategies
# ──────────────────────────────────────────────

def extract_projects(soup, base_url):
    projects = []
    seen_urls = set()

    def _add(title, url, desc='', contact='', date_text='', status_text=''):
        if not title or not url or url in seen_urls:
            return
        seen_urls.add(url)
        projects.append({
            'title': title.strip(),
            'description': desc.strip()[:500],
            'url': url,
            'contact_name': contact.strip(),
            'contact_email': '',
            '_date_text': date_text,
            '_status_text': status_text,
        })

    # Strategy 1: Data-attribute cards (React/Next.js)
    for attr in ['data-gtm', 'data-testid', 'data-id', 'data-entity-id']:
        for card in soup.select(f'[{attr}]'):
            link_el = card.select_one('a[href]')
            heading = card.select_one('h1, h2, h3, h4')
            if not link_el or not heading:
                continue
            title = heading.get_text(strip=True)
            href = link_el.get('href', '')
            if not title or len(title) < 3 or _is_skip_link(href):
                continue
            url = urljoin(base_url, href)
            _add(title, url, _find_nearest_text(card, DESC_HINTS),
                 _find_contact(card), _find_date_text(card), _find_status_text(card))
    if projects:
        return projects

    # Strategy 2: <a> wrapping a heading
    for link_el in soup.select('a[href]'):
        heading = link_el.select_one('h1, h2, h3, h4')
        if not heading:
            continue
        title = heading.get_text(strip=True)
        href = link_el.get('href', '')
        if not title or len(title) < 3 or _is_skip_link(href):
            continue
        url = urljoin(base_url, href)
        desc = _find_nearest_text(link_el, DESC_HINTS)
        parent = link_el.parent
        if not desc and parent:
            desc = _find_nearest_text(parent, DESC_HINTS)
        _add(title, url, desc, _find_contact(parent or link_el),
             _find_date_text(parent or link_el), _find_status_text(parent or link_el))
    if projects:
        return projects

    # Strategy 3: Heading containing a link
    for heading in soup.select('h1 a[href], h2 a[href], h3 a[href], h4 a[href]'):
        title = heading.get_text(strip=True)
        href = heading.get('href', '')
        if not title or len(title) < 3 or _is_skip_link(href):
            continue
        url = urljoin(base_url, href)
        container = heading.parent
        if container:
            container = container.parent
        _add(title, url,
             _find_nearest_text(container, DESC_HINTS) if container else '',
             _find_contact(container) if container else '',
             _find_date_text(container) if container else '',
             _find_status_text(container) if container else '')
    if projects:
        return projects

    # Strategy 4: Pure/CRIS portal selectors
    for container in soup.select(
        '.result-container .list-result-item, .rendering, '
        '.result-container li, .list-results li, '
        '.portal-body .result-container li'
    ):
        title_el = container.select_one('h3 a, h2 a, .result-title a, a.link, .title a')
        if not title_el:
            continue
        title = title_el.get_text(strip=True)
        href = title_el.get('href', '')
        if not title or _is_skip_link(href):
            continue
        _add(title, urljoin(base_url, href), _find_nearest_text(container, DESC_HINTS),
             _find_contact(container), _find_date_text(container), _find_status_text(container))
    if projects:
        return projects

    # Strategy 5: Generic card/grid containers
    for card in soup.select(
        '.card, .project-card, .item, article, '
        '.view-content .views-row, .search-result, '
        '[class*="card"], [class*="result"], [class*="item"]'
    ):
        link_el = card.select_one('a[href]')
        if not link_el:
            continue
        href = link_el.get('href', '')
        if _is_skip_link(href):
            continue
        heading = card.select_one('h1, h2, h3, h4, h5')
        title = heading.get_text(strip=True) if heading else link_el.get_text(strip=True)
        if not title or len(title) < 5 or len(title) > 300:
            continue
        _add(title, urljoin(base_url, href), _find_nearest_text(card, DESC_HINTS),
             _find_contact(card), _find_date_text(card), _find_status_text(card))
    if projects:
        return projects

    # Strategy 6: Link-based fallback
    PROJECT_URL_HINTS = [
        'project', 'research', 'tutkimus', 'hanke', 'forskning', 'projekt',
        'r2b', 'tutli', 'pre-commerci', 'innovation', 'startup',
    ]
    seen_titles = set()
    for link_el in soup.select('a[href]'):
        href = link_el.get('href', '')
        text = link_el.get_text(strip=True)
        if not text or len(text) < 5 or len(text) > 200 or _is_skip_link(href):
            continue
        full_url = urljoin(base_url, href)
        if text in seen_titles or full_url in seen_urls:
            continue
        if any(kw in href.lower() or kw in text.lower() for kw in PROJECT_URL_HINTS):
            seen_titles.add(text)
            _add(text, full_url)

    return projects


# ──────────────────────────────────────────────
# DETAIL PAGE EXTRACTION
# ──────────────────────────────────────────────

def fetch_detail_page(url):
    """
    Fetch a project detail page.
    Returns (full_text, contact_name, contact_email, start_date, end_date).
    """
    soup = fetch_page(url)
    if not soup:
        return '', '', '', '', ''

    # ── Full text ──
    full_text = ''
    for sel in ['main article', 'main', '#content', '.content',
                'article', '[role="main"]', '.page-content',
                '.node-content', '.entry-content', '.post-content']:
        el = soup.select_one(sel)
        if el:
            full_text = el.get_text(' ', strip=True)[:3000]
            if len(full_text) > 100:
                break
    if not full_text:
        for tag in soup.select('script, style, nav, header, footer'):
            tag.decompose()
        full_text = soup.get_text(' ', strip=True)[:3000]

    # ── Email ──
    email = ''
    # Standard mailto links
    for mailto in soup.select('a[href^="mailto:"]'):
        addr = mailto.get('href', '').replace('mailto:', '').split('?')[0].strip()
        # Strip any HTML tags that leaked into the href
        addr = re.sub(r'<[^>]+>', '', addr).strip()
        if '@' in addr:
            email = addr
            break
    # Spam-protected emails: "user[at]domain.fi" or "user [at] domain [dot] fi"
    if not email:
        spam_re = re.compile(
            r'([\w.+-]+)\s*\[at\]\s*([\w.-]+(?:\[dot\][\w.-]+)+|[\w.-]+\.\w{2,})',
            re.IGNORECASE
        )
        page_text = full_text[:5000]
        m = spam_re.search(page_text)
        if m:
            local = m.group(1)
            domain = m.group(2).replace('[dot]', '.').replace(' ', '')
            email = f'{local}@{domain}'

    # ── Contact name ──
    name = ''
    # Try specific selectors
    for sel in ['.person-name', '.contact-name', '.author', '.researcher-name',
                '.pi-name', '.field-name-field-contact', '.responsible-person',
                '[class*="person-name"]', '[class*="contact-name"]',
                '[class*="author"]', '[class*="researcher"]',
                '[class*="responsible"]', '[class*="leader"]',
                '[class*="member"] a']:
        el = soup.select_one(sel)
        if el:
            txt = el.get_text(strip=True)
            if txt and 3 < len(txt) < 80:
                name = txt
                break
    # Try to find name near email link
    if not name and email:
        for mailto in soup.select('a[href^="mailto:"]'):
            txt = mailto.get_text(strip=True)
            if txt and '@' not in txt and '[at]' not in txt and 3 < len(txt) < 80:
                name = txt
                break
    # Try to find name from text patterns like "Contact: Name" or "Responsible: Name"
    if not name:
        contact_re = re.compile(
            r'(?:contact|responsible|leader|principal investigator|PI|coordinator)\s*[:]\s*'
            r'([A-ZÄÖÜÅÆØ][a-zäöüåæø]+(?:\s+[A-ZÄÖÜÅÆØ][a-zäöüåæø]+){1,3})',
        )
        m = contact_re.search(full_text)
        if m:
            name = m.group(1).strip()

    # ── Start / end dates ──
    start_date = ''
    end_date = ''
    date_matches = DATE_RANGE_RE.findall(full_text)
    if date_matches:
        start_date = date_matches[0][0].strip()
        end_date = date_matches[0][1].strip()

    return full_text, name, email, start_date, end_date


# ──────────────────────────────────────────────
# CLASSIFICATION
# ──────────────────────────────────────────────

def classify_project(title, description, detail_text=''):
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
    qualifies = len(categories) >= MIN_CATEGORIES and score >= MIN_KEYWORD_HITS
    return qualifies, categories, unique_keywords, score


def make_id(title, url):
    raw = f"{title.lower().strip()}|{url.lower().strip()}"
    return hashlib.md5(raw.encode()).hexdigest()[:12]


# ──────────────────────────────────────────────
# MAIN
# ──────────────────────────────────────────────

def main():
    repo_root    = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    sources_path = os.path.join(repo_root, 'sources.json')
    data_path    = os.path.join(repo_root, 'data', 'projects.json')

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
    stats = {'new': 0, 'skipped_known': 0, 'skipped_inactive': 0, 'skipped_irrelevant': 0}

    print(f"=== Cloudberry Research Radar Scraper ===")
    print(f"Time: {now}")
    print(f"Sources: {len(sources)}")
    print(f"Existing projects in DB: {len(existing_projects)}")
    print(f"Qualification: min {MIN_KEYWORD_HITS} keyword hits, min {MIN_CATEGORIES} category")
    print()

    for source in sources:
        print(f"[SCRAPING] {source['name']}")
        print(f"  URL: {source['url']}")

        soup = fetch_page(source['url'])
        if not soup:
            continue

        raw_projects = extract_projects(soup, source['url'])
        print(f"  Found {len(raw_projects)} project(s) on listing page")

        for raw in raw_projects:
            pid = make_id(raw['title'], raw['url'])

            # ── INCREMENTAL: skip projects we already know ──
            if pid in existing_projects:
                existing_projects[pid]['last_seen'] = now
                stats['skipped_known'] += 1
                continue

            # ── Quick pre-check on title + whatever description we got ──
            has_description = len(raw.get('description', '')) > 30
            _, _, _, quick_score = classify_project(
                raw['title'], raw.get('description', '')
            )

            if quick_score == 0 and has_description:
                url_lower   = raw.get('url', '').lower()
                title_lower = raw.get('title', '').lower()
                RELEVANCE_HINTS = [
                    'photon', 'optic', 'laser', 'semiconductor', 'quantum',
                    'nano', 'material', 'chip', 'wafer', 'sensor', 'metrol',
                    'r2b', 'pre-commerci', 'tutli', 'erc', 'deep-tech',
                    'deeptech', 'commerciali', 'thin film', 'plasma',
                    'epitax', 'lithograph', 'crystal',
                ]
                if not any(h in url_lower or h in title_lower for h in RELEVANCE_HINTS):
                    stats['skipped_irrelevant'] += 1
                    continue

            # ── Fetch detail page (only for NEW projects) ──
            detail_text   = ''
            contact_name  = raw.get('contact_name', '')
            contact_email = raw.get('contact_email', '')
            start_date    = ''
            end_date      = ''

            if raw.get('url') and raw['url'] != source['url']:
                detail_text, det_name, det_email, det_start, det_end = fetch_detail_page(raw['url'])
                if det_name and not contact_name:
                    contact_name = det_name
                if det_email and not contact_email:
                    contact_email = det_email
                if det_start:
                    start_date = det_start
                if det_end:
                    end_date = det_end
                if not has_description and detail_text:
                    raw['description'] = detail_text[:300].rsplit(' ', 1)[0] + '...'

            # ── Full classification with detail text ──
            qualifies, categories, matched_kw, score = classify_project(
                raw['title'], raw.get('description', ''), detail_text
            )

            if not qualifies:
                stats['skipped_irrelevant'] += 1
                continue

            # ── Active check ──
            combined_status = f"{raw.get('_date_text', '')} {raw.get('_status_text', '')}"
            active, status_hint = is_project_active(
                raw['title'], raw.get('description', ''),
                f"{combined_status} {detail_text}"
            )

            if not active:
                stats['skipped_inactive'] += 1
                print(f"  ✗ INACTIVE: {raw['title'][:60]}... ({status_hint})")
                continue

            # ── Store qualifying, active, NEW project ──
            existing_projects[pid] = {
                'id': pid,
                'title': raw['title'],
                'description': raw.get('description', ''),
                'url': raw.get('url', ''),
                'source_name': source['name'],
                'source_org': source.get('organization', source['name']),
                'country': source.get('country', ''),
                'contact_name': contact_name,
                'contact_email': contact_email,
                'start_date': start_date,
                'end_date': end_date,
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

    # ── Build output ──
    active_projects = [
        p for p in existing_projects.values()
        if p.get('status', 'active') == 'active' and p.get('is_relevant', False)
    ]
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
    for p in active_projects:
        c = p.get('country', 'Unknown') or 'Unknown'
        output['by_country'][c] = output['by_country'].get(c, 0) + 1

    with open(data_path, 'w') as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"=== Done ===")
    print(f"Active, qualifying projects: {len(active_projects)}")
    print(f"New this run: {stats['new']}")
    print(f"Already known (skipped): {stats['skipped_known']}")
    print(f"Skipped (not relevant): {stats['skipped_irrelevant']}")
    print(f"Skipped (inactive/ended): {stats['skipped_inactive']}")
    print()
    for label, data in [('By category', output['by_category']), ('By country', output['by_country'])]:
        print(f"{label}:")
        for k, v in data.items():
            print(f"  {k}: {v}")


if __name__ == '__main__':
    main()
