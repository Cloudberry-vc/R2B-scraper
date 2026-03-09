/**
 * Cloudberry Research Radar — Netlify Function
 * Manages sources.json via GitHub API so changes persist in the repo.
 *
 * Required environment variables:
 *   GITHUB_TOKEN   — Personal access token with 'repo' scope
 *   GITHUB_REPO    — Format: "owner/repo" (e.g. "cloudberry-vc/research-radar")
 *   GITHUB_BRANCH  — Branch name (default: "main")
 */

const GITHUB_API = 'https://api.github.com';
const FILE_PATH = 'sources.json';

exports.handler = async (event) => {
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';

  if (!token || !repo) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Server not configured. Set GITHUB_TOKEN and GITHUB_REPO env vars.' }),
    };
  }

  try {
    const body = JSON.parse(event.body);

    // 1. Get current file from GitHub
    const getRes = await fetch(`${GITHUB_API}/repos/${repo}/contents/${FILE_PATH}?ref=${branch}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json' },
    });

    if (!getRes.ok) {
      throw new Error(`GitHub API error: ${getRes.status}`);
    }

    const fileData = await getRes.json();
    const currentContent = Buffer.from(fileData.content, 'base64').toString('utf-8');
    let sources = JSON.parse(currentContent);

    // 2. Modify sources
    const { action, source, sources: bulkSources, index } = body;

    if (action === 'add' && source) {
      // Check for duplicate URL
      if (sources.some(s => s.url === source.url)) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Source with this URL already exists.', sources }),
        };
      }
      sources.push(source);
    } else if (action === 'bulk_add' && Array.isArray(bulkSources)) {
      const existingUrls = new Set(sources.map(s => s.url));
      const unique = bulkSources.filter(s => s.name && s.url && !existingUrls.has(s.url));
      sources.push(...unique);
    } else if (action === 'remove' && typeof index === 'number') {
      if (index >= 0 && index < sources.length) {
        sources.splice(index, 1);
      }
    } else {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid action. Use "add", "bulk_add", or "remove".' }),
      };
    }

    // 3. Update file on GitHub
    const newContent = Buffer.from(JSON.stringify(sources, null, 2)).toString('base64');
    const updateRes = await fetch(`${GITHUB_API}/repos/${repo}/contents/${FILE_PATH}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: action === 'bulk_add'
          ? `Bulk add ${(bulkSources || []).length} sources`
          : `${action === 'add' ? 'Add' : 'Remove'} source: ${source?.name || 'source #' + index}`,
        content: newContent,
        sha: fileData.sha,
        branch,
      }),
    });

    if (!updateRes.ok) {
      const errBody = await updateRes.text();
      throw new Error(`GitHub update failed: ${updateRes.status} ${errBody}`);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, sources }),
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
