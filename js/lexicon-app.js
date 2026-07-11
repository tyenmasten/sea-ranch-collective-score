const SCALE_BAR_PX = 100;
const SCALE_REF = {
  imperial: { distance: 10, label: '10 ft' },
  metric: { distance: 5, label: '5 m' },
};

const state = {
  unit: 'imperial',
  uploads: [],
  editingEntryId: null,
};

function syncChromeHeight() {
  const chrome = document.getElementById('appChrome');
  if (chrome) {
    document.documentElement.style.setProperty('--chrome-height', chrome.offsetHeight + 'px');
  }
}

function init() {
  syncChromeHeight();
  window.addEventListener('resize', syncChromeHeight);
  bindMetaToggles();
  bindUnitToggle();
  bindUpload();
  document.getElementById('saveBtn').addEventListener('click', saveLexiconEntry);
  const newEntryBtn = document.getElementById('newEntryBtn');
  if (newEntryBtn) newEntryBtn.addEventListener('click', startNewLexiconEntry);
  bindMyLexiconList();
  setTimeout(loadMyLexiconEntries, 0);
}

function bindMetaToggles() {
  document.querySelectorAll('[data-meta-group="metaData"] .meta-opt, [data-meta-group="element"] .meta-opt').forEach((btn) => {
    btn.addEventListener('click', () => btn.classList.toggle('sel'));
  });
  document.querySelectorAll('[data-meta-group="typology"] .meta-opt').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-meta-group="typology"] .meta-opt').forEach((b) => b.classList.remove('sel'));
      btn.classList.add('sel');
    });
  });
}

function bindUnitToggle() {
  const group = document.getElementById('unitGroup');
  if (!group) return;
  group.querySelectorAll('.btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.unit === state.unit) return;
      group.querySelectorAll('.btn').forEach((b) => b.classList.remove('sel'));
      btn.classList.add('sel');
      state.unit = btn.dataset.unit;
    });
  });
}

function bindUpload() {
  const zone = document.getElementById('uploadZone');
  const input = document.getElementById('fileInput');
  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    addFiles(input.files);
    input.value = '';
  });
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.add('dragover');
  });
  zone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
  });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove('dragover');
    addFiles(e.dataTransfer.files);
  });
}

function fileCategory(file) {
  if (file.type.startsWith('image/')) return 'Image';
  if (file.type.startsWith('video/')) return 'Video';
  if (/\.(pdf|svg|dwg|dxf|dgn)$/i.test(file.name)) return 'Drawing';
  if (/\.(tif|tiff|heic|scan)$/i.test(file.name) || file.type === 'application/octet-stream') return 'Scan';
  return file.type || 'File';
}

function renderUploadZone() {
  const zone = document.getElementById('uploadZone');
  if (!state.uploads.length) {
    zone.classList.remove('has-files');
    zone.innerHTML = 'Image · Video · Drawing · Scan<br><span style="font-size:8px;">Drop files or tap to browse</span>';
    return;
  }
  zone.classList.add('has-files');
  zone.innerHTML = state.uploads.map((f) =>
    `<span class="upload-file">${escapeHtml(f.name)} <span style="color:var(--dim);">(${fileCategory(f)})</span></span>`
  ).join('<br>') + '<br><span style="font-size:8px;">Drop or tap to add more</span>';
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function addFiles(fileList) {
  if (!fileList || !fileList.length) return;
  state.uploads = [...state.uploads, ...Array.from(fileList)];
  renderUploadZone();
}

function getSelectedMetaMulti(group) {
  return [...document.querySelectorAll(`[data-meta-group="${group}"] .meta-opt.sel`)]
    .map((btn) => btn.dataset.value);
}

function getSelectedTypology() {
  const sel = document.querySelector('[data-meta-group="typology"] .meta-opt.sel');
  return sel ? sel.dataset.value : null;
}

function collectLexiconEntry() {
  const lexiconName = document.getElementById('lexiconName').value.trim();
  return {
    author: document.getElementById('author').value.trim(),
    lexiconName,
    status: 'draft',
    markScale: {
      unit: state.unit,
      referenceLabel: SCALE_REF[state.unit].label,
      barPixels: SCALE_BAR_PX,
      referenceDistance: SCALE_REF[state.unit].distance,
    },
    metadata: {
      metaData: getSelectedMetaMulti('metaData'),
      element: getSelectedMetaMulti('element'),
      typology: getSelectedTypology(),
    },
    description: document.getElementById('description').value.trim(),
    uploads: state.uploads.map((f) => ({
      name: f.name,
      type: f.type || fileCategory(f),
      category: fileCategory(f),
      size: f.size,
    })),
    savedAt: new Date().toISOString(),
  };
}

function saveLexiconEntry() {
  requireLogin((user) => {
    const entry = collectLexiconEntry();
    entry.author = user.fullName;
    entry.authorRole = user.role;
    if (window.SketchComposer) {
      entry.sketch = window.SketchComposer.getSketch();
    }

    const isUpdate = !!state.editingEntryId;
    const entryId = state.editingEntryId || crypto.randomUUID();
    const saveBtn = document.getElementById('saveBtn');
    const originalText = saveBtn ? saveBtn.textContent : '';
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
    }

    const ref = window.db.collection('lexiconEntries').doc(entryId);
    const write = isUpdate ? ref.set(entry, { merge: true }) : ref.set(entry);
    write
      .then(() => {
        console.log('Lexicon entry saved to Firestore:', entryId, entry);
        state.editingEntryId = entryId;
        updateEditingUI();
        loadMyLexiconEntries();
        if (saveBtn) saveBtn.textContent = 'Saved \u2713';
        setTimeout(() => {
          if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = originalText;
          }
        }, 1500);
      })
      .catch((err) => {
        console.error('Failed to save lexicon entry:', err);
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.textContent = originalText;
        }
        alert('Could not save, check your connection and try again.');
      });
  });
}

function applyMetaSelections(metadata) {
  if (!metadata) return;
  ['metaData', 'element'].forEach((group) => {
    const values = metadata[group] || [];
    document.querySelectorAll(`[data-meta-group="${group}"] .meta-opt`).forEach((btn) => {
      btn.classList.toggle('sel', values.includes(btn.dataset.value));
    });
  });
  document.querySelectorAll('[data-meta-group="typology"] .meta-opt').forEach((btn) => {
    btn.classList.toggle('sel', btn.dataset.value === metadata.typology);
  });
}

function resetMetaDefaults() {
  document.querySelectorAll(
    '[data-meta-group="metaData"] .meta-opt, [data-meta-group="element"] .meta-opt, [data-meta-group="typology"] .meta-opt'
  ).forEach((btn) => {
    btn.classList.remove('sel');
  });
}

function applySketchState(sketch) {
  if (window.SketchComposer) {
    window.SketchComposer.setSketch(sketch || null);
  }
}

function updateEditingUI() {
  const indicator = document.getElementById('editingIndicator');
  const nameEl = document.getElementById('editingEntryName');
  const newBtn = document.getElementById('newEntryBtn');
  const editing = !!state.editingEntryId;
  if (indicator) indicator.hidden = !editing;
  if (newBtn) newBtn.hidden = !editing;
  if (nameEl) {
    nameEl.textContent = editing
      ? (document.getElementById('lexiconName').value.trim() || '(untitled)')
      : '';
  }
  const listEl = document.getElementById('myLexiconList');
  if (listEl) {
    listEl.querySelectorAll('.my-lexicon-item').forEach((btn) => {
      btn.classList.toggle('sel', btn.dataset.id === state.editingEntryId);
    });
  }
}

function loadLexiconEntry(entryId) {
  if (!window.db || !entryId) return;

  window.db.collection('lexiconEntries').doc(entryId).get()
    .then((doc) => {
      if (!doc.exists) {
        console.warn('Lexicon entry not found:', entryId);
        return;
      }
      const entry = doc.data();
      state.editingEntryId = doc.id;

      document.getElementById('lexiconName').value = entry.lexiconName || '';
      document.getElementById('description').value = entry.description || '';

      if (entry.markScale && entry.markScale.unit) {
        state.unit = entry.markScale.unit;
        document.querySelectorAll('#unitGroup .btn').forEach((btn) => {
          btn.classList.toggle('sel', btn.dataset.unit === state.unit);
        });
      }

      applyMetaSelections(entry.metadata || {});
      applySketchState(entry.sketch || null);
      state.uploads = [];
      renderUploadZone();
      updateEditingUI();
    })
    .catch((err) => {
      console.error('Failed to load lexicon entry:', err);
      alert('Could not load this entry, check your connection and try again.');
    });
}

function startNewLexiconEntry() {
  state.editingEntryId = null;
  document.getElementById('lexiconName').value = '';
  document.getElementById('description').value = '';
  state.unit = 'imperial';
  document.querySelectorAll('#unitGroup .btn').forEach((btn) => {
    btn.classList.toggle('sel', btn.dataset.unit === 'imperial');
  });
  resetMetaDefaults();
  applySketchState(null);
  state.uploads = [];
  renderUploadZone();
  updateEditingUI();
}

function loadMyLexiconEntries() {
  const listEl = document.getElementById('myLexiconList');
  if (!listEl || !window.db) return;

  const user = window.currentUser;
  if (!user || !user.fullName) {
    listEl.innerHTML = '';
    return;
  }

  window.db.collection('lexiconEntries')
    .where('author', '==', user.fullName)
    .get()
    .then((snapshot) => {
      const entries = [];
      snapshot.forEach((doc) => {
        entries.push({ id: doc.id, ...doc.data() });
      });
      entries.sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));

      listEl.innerHTML = entries.map((entry) => {
        const name = escapeHtml(entry.lexiconName || '(untitled)');
        const ts = entry.savedAt
          ? escapeHtml(new Date(entry.savedAt).toLocaleString())
          : '';
        const sel = entry.id === state.editingEntryId ? ' sel' : '';
        return (
          `<button type="button" class="my-lexicon-item${sel}" data-id="${escapeHtml(entry.id)}">` +
          `<span class="my-lexicon-name">${name}</span>` +
          `<span class="my-lexicon-time">${ts}</span>` +
          `</button>`
        );
      }).join('');
    })
    .catch((err) => {
      console.error('Failed to load lexicon entries:', err);
    });
}

function bindMyLexiconList() {
  const listEl = document.getElementById('myLexiconList');
  if (!listEl) return;
  listEl.addEventListener('click', (e) => {
    const item = e.target.closest('[data-id]');
    if (!item) return;
    loadLexiconEntry(item.dataset.id);
  });
}

init();
