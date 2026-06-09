const SCALE_BAR_PX = 100;
const SCALE_REF = {
  imperial: { distance: 10, label: '10 ft' },
  metric: { distance: 5, label: '5 m' },
};

const state = {
  unit: 'imperial',
  uploads: [],
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
  const entry = collectLexiconEntry();
  console.log('Lexicon entry saved (local preview — Firebase not connected):');
  console.log(entry);
  console.log(JSON.stringify(entry, null, 2));
}

init();
