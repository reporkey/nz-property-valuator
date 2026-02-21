/**
 * popup.js — Settings interface for NZ Property Valuator
 *
 * Reads/writes chrome.storage.sync for per-source enabled toggles.
 * Reads chrome.storage.local for last fetch status per source.
 * Sends CLEAR_CACHE to background.js to wipe the in-memory cache.
 */

'use strict';

const SOURCES = ['OneRoof', 'homes.co.nz', 'PropertyValue', 'RealEstate.co.nz'];

const DEFAULT_SOURCE_SETTINGS = {
  OneRoof:            { enabled: true },
  'homes.co.nz':      { enabled: true },
  PropertyValue:      { enabled: true },
  'RealEstate.co.nz': { enabled: true },
};

// ── Helpers ────────────────────────────────────────────────────────────────

// Format a fetchStatus entry into { text, cls } for display.
function formatStatus(entry) {
  if (!entry) return { text: '—', cls: 'none' };

  const ageMs  = Date.now() - entry.ts;
  const ageMins = Math.round(ageMs / 60_000);
  const ago = ageMins < 1 ? 'just now'
            : ageMins === 1 ? '1 min ago'
            : `${ageMins} min ago`;

  if (entry.ok) {
    return { text: `✓ ${entry.estimate} · ${ago}`, cls: 'ok' };
  }
  if (!entry.error || /not found|not available|no estimate/i.test(entry.error)) {
    return { text: `No estimate · ${ago}`, cls: 'none' };
  }
  return { text: `✗ Failed · ${ago}`, cls: 'fail' };
}

// ── Init ───────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // ── Version ────────────────────────────────────────────────────────────
  const { version } = chrome.runtime.getManifest();
  document.getElementById('version').textContent = `v${version}`;

  // ── Load settings + fetch status in parallel ───────────────────────────
  const [syncData, localData] = await Promise.all([
    chrome.storage.sync.get({ sources: DEFAULT_SOURCE_SETTINGS }),
    chrome.storage.local.get({ fetchStatus: {} }),
  ]);

  const sources     = syncData.sources;
  const fetchStatus = localData.fetchStatus;

  // ── Render each source row ─────────────────────────────────────────────
  for (const name of SOURCES) {
    // Toggle
    const toggle  = document.getElementById(`toggle-${name}`);
    toggle.checked = sources[name]?.enabled !== false;

    // Status
    const statusEl = document.getElementById(`status-${name}`);
    const { text, cls } = formatStatus(fetchStatus[name]);
    statusEl.textContent = text;
    statusEl.className   = `source-status ${cls}`;

    // Persist toggle changes to sync storage
    toggle.addEventListener('change', async () => {
      const current = (await chrome.storage.sync.get({ sources: DEFAULT_SOURCE_SETTINGS })).sources;
      await chrome.storage.sync.set({
        sources: { ...current, [name]: { enabled: toggle.checked } },
      });
    });
  }

  // ── Clear cache button ─────────────────────────────────────────────────
  const clearBtn = document.getElementById('clear-cache');

  clearBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });

    clearBtn.textContent = '✓ Cache cleared';
    clearBtn.classList.add('done');

    setTimeout(() => {
      clearBtn.textContent = 'Clear cache';
      clearBtn.classList.remove('done');
    }, 2000);
  });
});
