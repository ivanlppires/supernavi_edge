/**
 * SuperNavi Edge Dashboard — app.js
 *
 * Single-page dashboard with 4 tabs: Status, Laminas, Atividade, Configuracoes.
 * All dynamic content rendered via safe DOM methods (NO innerHTML with API data).
 */

(function () {
  'use strict';

  // ---- Constants ----
  const MAX_ACTIVITY_EVENTS = 100;
  const DASHBOARD_REFRESH_MS = 10_000;

  // ---- State ----
  let activityEvents = [];
  let currentFilter = 'all';
  let slidesData = [];
  let eventSource = null;
  let dashboardTimer = null;

  // ---- DOM references (cached after DOMContentLoaded) ----
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // =====================
  //  Tab Navigation
  // =====================
  function initTabs() {
    const tabBar = $('#tabBar');
    tabBar.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab-btn');
      if (!btn) return;
      const tabId = btn.dataset.tab;

      // Deactivate all
      $$('.tab-btn').forEach((b) => b.classList.remove('active'));
      $$('.tab-panel').forEach((p) => p.classList.remove('active'));

      // Activate selected
      btn.classList.add('active');
      const panel = $(`#panel-${tabId}`);
      if (panel) panel.classList.add('active');

      // Lazy-load data for the activated tab
      if (tabId === 'slides') fetchSlides();
      if (tabId === 'settings') loadSettings();
    });
  }

  // =====================
  //  Utility: Relative Time in Portuguese
  // =====================
  function relativeTime(dateStr) {
    if (!dateStr) return '';
    const now = Date.now();
    const then = new Date(dateStr).getTime();
    const diffSec = Math.floor((now - then) / 1000);
    if (diffSec < 0) return 'agora';
    if (diffSec < 60) return 'agora';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `h\u00e1 ${diffMin} min`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `h\u00e1 ${diffHr}h`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay === 1) return 'h\u00e1 1 dia';
    return `h\u00e1 ${diffDay} dias`;
  }

  function formatTime(date) {
    const d = date instanceof Date ? date : new Date(date);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  // =====================
  //  Safe DOM helpers
  // =====================
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'className') node.className = v;
        else if (k === 'textContent') node.textContent = v;
        else node.setAttribute(k, v);
      }
    }
    if (children) {
      if (!Array.isArray(children)) children = [children];
      for (const child of children) {
        if (typeof child === 'string') {
          node.appendChild(document.createTextNode(child));
        } else if (child) {
          node.appendChild(child);
        }
      }
    }
    return node;
  }

  function clearChildren(parent) {
    while (parent.firstChild) parent.removeChild(parent.firstChild);
  }

  function setText(selector, text) {
    const node = typeof selector === 'string' ? $(selector) : selector;
    if (node) node.textContent = text;
  }

  function setDotClass(selector, stateClass) {
    const dot = typeof selector === 'string' ? $(selector) : selector;
    if (!dot) return;
    dot.className = 'status-dot ' + stateClass;
  }

  // =====================
  //  Tab 1: Status (Dashboard)
  // =====================
  async function fetchDashboard() {
    try {
      const res = await fetch('/v1/dashboard');
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      renderDashboard(data);
    } catch (err) {
      console.error('Dashboard fetch error:', err);
    }
  }

  function renderDashboard(data) {
    // Tunnel
    if (data.tunnel) {
      const connected = data.tunnel.connected;
      setDotClass('#tunnelDot', connected ? 'connected' : 'disconnected');
      setText('#tunnelStatusText', connected ? 'Conectado' : 'Desconectado');
      setText('#tunnelAgent', 'Agent: ' + (data.tunnel.agentId || '--'));
    }

    // Watcher
    if (data.watcher) {
      const state = data.watcher.state;
      let dotClass = 'disconnected';
      let label = 'Parado';
      if (state === 'running') { dotClass = 'connected'; label = 'Executando'; }
      else if (state === 'needs_config') { dotClass = 'warning'; label = 'Precisa configurar'; }
      else if (state === 'dir_inaccessible') { dotClass = 'warning'; label = 'Pasta inacess\u00edvel'; }
      setDotClass('#watcherDot', dotClass);
      setText('#watcherStatusText', label);
      setText('#watcherDir', 'Pasta: ' + (data.watcher.ingestDir || data.config?.slidesDirHost || '--'));
    }

    // DB
    if (data.slides) {
      setText('#dbSlideCount', 'L\u00e2minas: ' + data.slides.total);
    }

    // Queue
    if (data.jobs) {
      setText('#queuePending', 'Pendentes: ' + data.jobs.pending);
      setText('#queueRunning', 'Executando: ' + data.jobs.running);
    }

    // Processor
    if (data.jobs) {
      const processorBody = $('#processorBody');
      clearChildren(processorBody);

      if (data.jobs.active && data.jobs.active.length > 0) {
        for (const job of data.jobs.active) {
          const jobDiv = el('div', { className: 'active-job' });
          const nameDiv = el('div', { className: 'active-job-name' });
          nameDiv.textContent = job.original_filename || job.slide_id || '--';
          const typeDiv = el('div', { className: 'active-job-type' });
          typeDiv.textContent = job.type + ' - ' + job.status;
          jobDiv.appendChild(nameDiv);
          jobDiv.appendChild(typeDiv);
          processorBody.appendChild(jobDiv);
        }
      } else {
        const idleDiv = el('div', { className: 'card-detail' });
        idleDiv.textContent = 'Ocioso';
        processorBody.appendChild(idleDiv);
      }
    }

    // Disk (slide counts by status)
    if (data.slides) {
      setText('#diskReady', 'Prontas: ' + data.slides.ready);
      setText('#diskProcessing', 'Processando: ' + data.slides.processing);
      setText('#diskQueued', 'Na fila: ' + data.slides.queued);
      setText('#diskFailed', 'Com erro: ' + data.slides.failed);
    }
  }

  function startDashboardPolling() {
    fetchDashboard();
    dashboardTimer = setInterval(fetchDashboard, DASHBOARD_REFRESH_MS);
  }

  // =====================
  //  Tab 2: Slides
  // =====================
  async function fetchSlides() {
    try {
      const res = await fetch('/v1/slides');
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      slidesData = data.items || [];
      renderSlides();
    } catch (err) {
      console.error('Slides fetch error:', err);
    }
  }

  function renderSlides() {
    const container = $('#slidesList');
    const countEl = $('#slidesCount');
    const emptyEl = $('#slidesEmpty');

    // Filter
    const filtered = currentFilter === 'all'
      ? slidesData
      : slidesData.filter((s) => s.status === currentFilter);

    // Update count
    const countText = filtered.length === 1
      ? '1 l\u00e2mina'
      : filtered.length + ' l\u00e2minas';
    setText(countEl, countText);

    // Clear existing cards (but keep the empty state element)
    const existingCards = container.querySelectorAll('.slide-card');
    existingCards.forEach((c) => c.remove());

    if (filtered.length === 0) {
      if (emptyEl) emptyEl.style.display = '';
      return;
    }

    if (emptyEl) emptyEl.style.display = 'none';

    for (const slide of filtered) {
      const card = buildSlideCard(slide);
      container.appendChild(card);
    }
  }

  function buildSlideCard(slide) {
    const card = el('div', { className: 'slide-card' });
    card.setAttribute('data-status', slide.status || 'queued');
    card.setAttribute('data-slide-id', slide.slideId);

    // Thumbnail
    const thumb = el('img', { className: 'slide-thumb' });
    thumb.setAttribute('src', '/v1/slides/' + encodeURIComponent(slide.slideId) + '/thumb');
    thumb.setAttribute('alt', '');
    thumb.setAttribute('loading', 'lazy');
    thumb.addEventListener('error', function () {
      // Replace broken image with SVG placeholder
      const placeholder = el('div', { className: 'slide-thumb-placeholder' });
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', '24');
      svg.setAttribute('height', '24');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '1.5');
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', '3');
      rect.setAttribute('y', '3');
      rect.setAttribute('width', '18');
      rect.setAttribute('height', '18');
      rect.setAttribute('rx', '2');
      rect.setAttribute('ry', '2');
      const circ = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circ.setAttribute('cx', '8.5');
      circ.setAttribute('cy', '8.5');
      circ.setAttribute('r', '1.5');
      const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      poly.setAttribute('points', '21,15 16,10 5,21');
      svg.appendChild(rect);
      svg.appendChild(circ);
      svg.appendChild(poly);
      placeholder.appendChild(svg);
      card.replaceChild(placeholder, thumb);
    });
    card.appendChild(thumb);

    // Info section
    const info = el('div', { className: 'slide-info' });
    const filename = el('div', { className: 'slide-filename' });
    filename.textContent = slide.originalFilename || '--';
    info.appendChild(filename);

    const meta = el('div', { className: 'slide-meta' });

    // Format badge
    const format = (slide.format || 'unknown').toUpperCase();
    const formatBadge = el('span', { className: 'badge badge-format' });
    formatBadge.textContent = format;
    meta.appendChild(formatBadge);

    // Dimensions
    if (slide.width && slide.height) {
      const dims = el('span', { className: 'slide-meta-item' });
      dims.textContent = slide.width + ' \u00d7 ' + slide.height;
      meta.appendChild(dims);
    }

    // Magnification
    if (slide.appMag) {
      const mag = el('span', { className: 'slide-meta-item' });
      mag.textContent = slide.appMag + '\u00d7';
      meta.appendChild(mag);
    }

    info.appendChild(meta);

    // OCR indicator
    if (slide.ocrStatus) {
      const ocrRow = el('div', { className: 'slide-ocr' });
      const ocrBadge = el('span', {
        className: 'ocr-badge ' + (slide.ocrStatus === 'done' ? 'ocr-done' : 'ocr-pending')
      });

      if (slide.ocrStatus === 'done') {
        ocrBadge.textContent = 'OCR: ' + (slide.externalSlideLabel || '?');
      } else {
        ocrBadge.textContent = 'OCR: Pendente';
      }

      ocrRow.appendChild(ocrBadge);

      if (slide.hasLabel) {
        ocrBadge.classList.add('clickable');
        ocrBadge.addEventListener('click', (e) => {
          e.stopPropagation();
          openOcrModal(slide);
        });
      }

      info.appendChild(ocrRow);
    }

    card.appendChild(info);

    // Right section: status + time
    const right = el('div', { className: 'slide-right' });

    const statusBadge = el('span', { className: 'badge badge-' + (slide.status || 'queued') });
    statusBadge.textContent = statusLabel(slide.status);
    right.appendChild(statusBadge);

    const time = el('span', { className: 'slide-time' });
    time.textContent = relativeTime(slide.createdAt);
    right.appendChild(time);

    card.appendChild(right);

    return card;
  }

  function statusLabel(status) {
    const labels = {
      ready: 'Pronta',
      processing: 'Processando',
      queued: 'Na fila',
      failed: 'Erro'
    };
    return labels[status] || status || '--';
  }

  function initSlideFilters() {
    const filterBtns = $('#filterButtons');
    filterBtns.addEventListener('click', (e) => {
      const btn = e.target.closest('.filter-btn');
      if (!btn) return;

      $$('.filter-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      renderSlides();
    });
  }

  // =====================
  //  OCR Review Modal
  // =====================
  let currentOcrSlideId = null;

  // Client-side OCR parse (mirrors backend parseOcrResponse)
  function parseOcrInput(text) {
    if (!text || typeof text !== 'string') return null;
    const trimmed = text.trim().toUpperCase();
    if (!trimmed) return null;

    // Abbreviated format: 26_388A → AP26000388A
    const abbrMatch = trimmed.match(/^(\d{2})[_](\d{1,6})([A-Z]\d*)?$/i);
    if (abbrMatch) {
      const left = abbrMatch[1];
      const right = abbrMatch[2];
      const suffix = (abbrMatch[3] || '').toUpperCase();
      const zeros = Math.max(0, 8 - left.length - right.length);
      const caseBase = 'AP' + left + '0'.repeat(zeros) + right;
      return { fullName: caseBase + suffix, caseBase, slideLabel: suffix };
    }

    // Standard format: AP26000388A1
    const cleaned = trimmed.replace(/[\s\-_.]/g, '');
    if (!cleaned) return null;
    const match = cleaned.match(/^((?:AP|PA|IM|C)\d{6,12})([A-Z]\d*)?$/i);
    if (!match) return null;
    const caseBase = match[1].replace(/^PA/, 'AP');
    const slideLabel = match[2] || '';
    return { fullName: caseBase + slideLabel, caseBase, slideLabel };
  }

  function initOcrModal() {
    const overlay = $('#ocrModal');
    const closeBtn = $('#ocrModalClose');
    const closeBtn2 = $('#btnCloseOcr');
    const reocrBtn = $('#btnReocr');

    if (closeBtn) closeBtn.addEventListener('click', closeOcrModal);
    if (closeBtn2) closeBtn2.addEventListener('click', closeOcrModal);

    if (overlay) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeOcrModal();
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeOcrModal();
    });

    if (reocrBtn) reocrBtn.addEventListener('click', triggerReocr);

    // Image tabs
    const tabs = overlay ? overlay.querySelectorAll('.ocr-tab') : [];
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        switchOcrImage(tab.dataset.tab);
      });
    });

    // Manual edit — live validation
    const manualInput = $('#ocrManualInput');
    const saveBtn = $('#btnManualSave');
    if (manualInput) {
      manualInput.addEventListener('input', () => {
        const val = manualInput.value;
        const parsed = parseOcrInput(val);
        const preview = $('#ocrManualPreview');

        if (!val.trim()) {
          manualInput.className = 'ocr-manual-input';
          if (preview) { preview.textContent = ''; preview.className = 'ocr-manual-preview'; }
          if (saveBtn) saveBtn.disabled = true;
          return;
        }

        if (parsed) {
          manualInput.className = 'ocr-manual-input input-valid';
          if (preview) {
            preview.textContent = '\u2192 ' + parsed.caseBase + ' + ' + (parsed.slideLabel || '(sem sufixo)');
            preview.className = 'ocr-manual-preview preview-valid';
          }
          if (saveBtn) saveBtn.disabled = false;
        } else {
          manualInput.className = 'ocr-manual-input input-invalid';
          if (preview) {
            preview.textContent = 'Formato inv\u00e1lido';
            preview.className = 'ocr-manual-preview preview-invalid';
          }
          if (saveBtn) saveBtn.disabled = true;
        }
      });
    }

    if (saveBtn) saveBtn.addEventListener('click', triggerManualSave);
  }

  function switchOcrImage(tab) {
    const slide2Img = $('#ocrSlide2Image');
    const labelImg = $('#ocrLabelImage');
    const placeholder = $('#ocrLabelPlaceholder');

    if (tab === 'slide2') {
      if (slide2Img) slide2Img.style.display = '';
      if (labelImg) labelImg.style.display = 'none';
      if (placeholder) placeholder.style.display = 'none';
      if (slide2Img && slide2Img.dataset.failed === 'true') {
        if (slide2Img) slide2Img.style.display = 'none';
        if (placeholder) placeholder.style.display = '';
      }
    } else {
      if (slide2Img) slide2Img.style.display = 'none';
      if (labelImg) labelImg.style.display = '';
      if (placeholder) placeholder.style.display = 'none';
      if (labelImg && labelImg.dataset.failed === 'true') {
        if (labelImg) labelImg.style.display = 'none';
        if (placeholder) placeholder.style.display = '';
      }
    }
  }

  function openOcrModal(slide) {
    const overlay = $('#ocrModal');
    if (!overlay) return;

    currentOcrSlideId = slide.slideId;
    const slideUrl = '/v1/slides/' + encodeURIComponent(slide.slideId);

    // Load slide2 image (primary)
    const slide2Img = $('#ocrSlide2Image');
    if (slide2Img) {
      slide2Img.dataset.failed = 'false';
      slide2Img.src = slideUrl + '/slide2';
      slide2Img.style.display = '';
      slide2Img.onerror = function () {
        slide2Img.dataset.failed = 'true';
        slide2Img.style.display = 'none';
        const placeholder = $('#ocrLabelPlaceholder');
        if (placeholder) placeholder.style.display = '';
      };
    }

    // Load label image (secondary tab)
    const labelImg = $('#ocrLabelImage');
    if (labelImg) {
      labelImg.dataset.failed = 'false';
      labelImg.src = slideUrl + '/label';
      labelImg.style.display = 'none';
      labelImg.onerror = function () {
        labelImg.dataset.failed = 'true';
      };
    }

    // Reset tabs to slide2
    const tabs = overlay.querySelectorAll('.ocr-tab');
    tabs.forEach(t => t.classList.remove('active'));
    const slide2Tab = overlay.querySelector('.ocr-tab[data-tab="slide2"]');
    if (slide2Tab) slide2Tab.classList.add('active');

    const placeholder = $('#ocrLabelPlaceholder');
    if (placeholder) placeholder.style.display = 'none';

    // Set reading info
    setText('#ocrReading', slide.externalSlideLabel || '--');
    setText('#ocrFilename', slide.originalFilename || '--');

    const statusText = slide.ocrStatus === 'done' ? 'Conclu\u00eddo' : 'Pendente';
    const statusEl = $('#ocrStatusValue');
    if (statusEl) {
      statusEl.textContent = statusText;
      statusEl.className = 'ocr-info-value ' + (slide.ocrStatus === 'done' ? 'ocr-val-done' : 'ocr-val-pending');
    }

    // Pre-fill manual input
    const manualInput = $('#ocrManualInput');
    if (manualInput) {
      manualInput.value = slide.externalSlideLabel || '';
      manualInput.className = 'ocr-manual-input';
      manualInput.dispatchEvent(new Event('input'));
    }

    // Clear status message
    const msgEl = $('#ocrStatusMsg');
    if (msgEl) {
      msgEl.textContent = '';
      msgEl.className = 'ocr-status-msg';
    }

    // Enable re-OCR button
    const reocrBtn = $('#btnReocr');
    if (reocrBtn) {
      reocrBtn.disabled = false;
      reocrBtn.textContent = 'Re-ler OCR';
    }

    overlay.classList.add('visible');
  }

  function closeOcrModal() {
    const overlay = $('#ocrModal');
    if (overlay) overlay.classList.remove('visible');
    currentOcrSlideId = null;
  }

  async function triggerReocr() {
    if (!currentOcrSlideId) return;

    const reocrBtn = $('#btnReocr');
    const msgEl = $('#ocrStatusMsg');

    // Set loading state
    if (reocrBtn) {
      reocrBtn.disabled = true;
      reocrBtn.textContent = 'Relendo...';
    }
    if (msgEl) {
      msgEl.textContent = 'Enviando label para an\u00e1lise OCR...';
      msgEl.className = 'ocr-status-msg loading';
    }

    try {
      const res = await fetch('/v1/slides/' + encodeURIComponent(currentOcrSlideId) + '/reocr', {
        method: 'POST'
      });

      const data = await res.json();

      if (data.success) {
        // Update modal with new reading
        setText('#ocrReading', data.fullName || '--');
        setText('#ocrFilename', data.newFilename || '--');
        const statusEl = $('#ocrStatusValue');
        if (statusEl) {
          statusEl.textContent = 'Conclu\u00eddo';
          statusEl.className = 'ocr-info-value ocr-val-done';
        }
        if (msgEl) {
          msgEl.textContent = 'OCR atualizado: ' + (data.fullName || '');
          msgEl.className = 'ocr-status-msg success';
        }
        // Refresh slides list
        fetchSlides();
        // Update manual input with new reading
        const manualInput = $('#ocrManualInput');
        if (manualInput) {
          manualInput.value = data.fullName || '';
          manualInput.dispatchEvent(new Event('input'));
        }
      } else {
        if (msgEl) {
          msgEl.textContent = data.message || 'N\u00e3o foi poss\u00edvel ler o label';
          msgEl.className = 'ocr-status-msg error';
        }
      }
    } catch (err) {
      if (msgEl) {
        msgEl.textContent = 'Erro: ' + err.message;
        msgEl.className = 'ocr-status-msg error';
      }
    } finally {
      if (reocrBtn) {
        reocrBtn.disabled = false;
        reocrBtn.textContent = 'Re-ler OCR';
      }
    }
  }

  async function triggerManualSave() {
    if (!currentOcrSlideId) return;

    const manualInput = $('#ocrManualInput');
    const saveBtn = $('#btnManualSave');
    const msgEl = $('#ocrStatusMsg');
    const name = manualInput ? manualInput.value.trim() : '';

    if (!name) return;

    if (saveBtn) saveBtn.disabled = true;
    if (msgEl) {
      msgEl.textContent = 'Salvando...';
      msgEl.className = 'ocr-status-msg loading';
    }

    try {
      const res = await fetch('/v1/slides/' + encodeURIComponent(currentOcrSlideId) + '/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });

      const data = await res.json();

      if (data.success) {
        setText('#ocrReading', data.fullName || '--');
        setText('#ocrFilename', data.newFilename || '--');
        const statusEl = $('#ocrStatusValue');
        if (statusEl) {
          statusEl.textContent = 'Conclu\u00eddo';
          statusEl.className = 'ocr-info-value ocr-val-done';
        }
        if (msgEl) {
          msgEl.textContent = 'Nome atualizado: ' + (data.fullName || '');
          msgEl.className = 'ocr-status-msg success';
        }
        fetchSlides();
      } else {
        if (msgEl) {
          msgEl.textContent = data.error || 'Erro ao salvar';
          msgEl.className = 'ocr-status-msg error';
        }
      }
    } catch (err) {
      if (msgEl) {
        msgEl.textContent = 'Erro: ' + err.message;
        msgEl.className = 'ocr-status-msg error';
      }
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  // =====================
  //  Tab 3: Activity Feed
  // =====================
  function addActivityEvent(eventType, data) {
    const event = {
      type: eventType,
      data: data,
      timestamp: new Date(),
      message: eventToMessage(eventType, data)
    };

    activityEvents.unshift(event);
    if (activityEvents.length > MAX_ACTIVITY_EVENTS) {
      activityEvents.length = MAX_ACTIVITY_EVENTS;
    }

    renderActivityItem(event, true);
    trimActivityFeed();
  }

  function eventToMessage(eventType, data) {
    const filename = data && data.filename
      ? data.filename
      : data && data.original_filename
        ? data.original_filename
        : '';

    switch (eventType) {
      case 'slide:import':
        return 'L\u00e2mina ' + filename + ' detectada na pasta';
      case 'slide:ready':
        return 'L\u00e2mina pronta para visualiza\u00e7\u00e3o';
      case 'tile:pending': {
        const z = data && data.z != null ? data.z : '?';
        return 'Gerando tile n\u00edvel ' + z;
      }
      case 'tile:generated': {
        const z2 = data && data.z != null ? data.z : '?';
        return 'Tile gerado n\u00edvel ' + z2;
      }
      case 'preview:published':
        return 'Preview publicado na nuvem';
      case 'preview:failed':
        return 'Falha ao publicar preview: ' + (data && data.error || 'erro');
      case 'connected':
        return 'Conex\u00e3o SSE estabelecida';
      default:
        return eventType + (filename ? ': ' + filename : '');
    }
  }

  function eventDotClass(eventType) {
    if (eventType === 'slide:import') return 'import';
    if (eventType === 'slide:ready') return 'ready';
    if (eventType.startsWith('tile:')) return 'tile';
    if (eventType === 'preview:published') return 'ready';
    if (eventType === 'preview:failed') return 'error';
    if (eventType === 'connected') return 'connection';
    return 'default';
  }

  function renderActivityItem(event, prepend) {
    const feed = $('#activityFeed');
    const emptyEl = $('#activityEmpty');
    if (emptyEl) emptyEl.style.display = 'none';

    const item = el('div', { className: 'activity-item' });

    const dot = el('span', { className: 'activity-dot ' + eventDotClass(event.type) });
    item.appendChild(dot);

    const content = el('div', { className: 'activity-content' });
    const msg = el('div', { className: 'activity-message' });
    msg.textContent = event.message;
    content.appendChild(msg);
    item.appendChild(content);

    const time = el('span', { className: 'activity-time' });
    time.textContent = formatTime(event.timestamp);
    item.appendChild(time);

    if (prepend) {
      feed.insertBefore(item, feed.firstChild);
    } else {
      feed.appendChild(item);
    }
  }

  function trimActivityFeed() {
    const feed = $('#activityFeed');
    const items = feed.querySelectorAll('.activity-item');
    while (items.length > MAX_ACTIVITY_EVENTS) {
      feed.removeChild(feed.lastElementChild);
    }
  }

  function clearActivityFeed() {
    activityEvents = [];
    const feed = $('#activityFeed');
    const items = feed.querySelectorAll('.activity-item');
    items.forEach((item) => item.remove());
    const emptyEl = $('#activityEmpty');
    if (emptyEl) emptyEl.style.display = '';
  }

  function initActivityControls() {
    const clearBtn = $('#clearActivity');
    if (clearBtn) {
      clearBtn.addEventListener('click', clearActivityFeed);
    }
  }

  // =====================
  //  Tab 4: Settings
  // =====================
  async function loadSettings() {
    try {
      const res = await fetch('/v1/admin/config');
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      populateSettingsForm(data);
    } catch (err) {
      console.error('Settings fetch error:', err);
    }
  }

  function populateSettingsForm(data) {
    const cfg = data.config || {};
    const cloud = cfg.cloud || {};

    // Cloud connection fields
    const edgeKey = $('#cfgEdgeKey');
    if (edgeKey) edgeKey.value = cloud.edgeKey || '';

    // Show edge info if key is configured
    if (cloud.edgeKey) {
      verifyAndShowEdgeInfo(cloud.edgeKey);
    } else {
      hideEdgeInfo();
    }

    // Scanner/dir fields
    const slidesDir = $('#cfgSlidesDir');
    if (slidesDir) slidesDir.value = cfg.slidesDirHost || '';

    const scannerType = $('#cfgScannerType');
    if (scannerType && cfg.scanner && cfg.scanner.type) {
      scannerType.value = cfg.scanner.type;
    }

    const stableSeconds = $('#cfgStableSeconds');
    const stableDisplay = $('#stableSecondsValue');
    if (stableSeconds && cfg.stableSeconds != null) {
      stableSeconds.value = cfg.stableSeconds;
      if (stableDisplay) stableDisplay.textContent = cfg.stableSeconds;
    }

  }

  function initSettingsForm() {
    // Password toggle for EDGE_KEY
    const toggleBtn = $('#toggleEdgeKey');
    const edgeKeyInput = $('#cfgEdgeKey');
    if (toggleBtn && edgeKeyInput) {
      toggleBtn.addEventListener('click', () => {
        const isPassword = edgeKeyInput.type === 'password';
        edgeKeyInput.type = isPassword ? 'text' : 'password';
        toggleBtn.querySelector('.icon-eye').style.display = isPassword ? 'none' : '';
        toggleBtn.querySelector('.icon-eye-off').style.display = isPassword ? '' : 'none';
      });
    }

    // Range slider live display
    const stableSeconds = $('#cfgStableSeconds');
    const stableDisplay = $('#stableSecondsValue');
    if (stableSeconds && stableDisplay) {
      stableSeconds.addEventListener('input', () => {
        stableDisplay.textContent = stableSeconds.value;
      });
    }

    // Save button
    const saveBtn = $('#saveConfig');
    const saveStatus = $('#saveStatus');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        setText(saveStatus, 'Salvando...');
        saveStatus.className = 'save-status';

        const edgeKeyValue = ($('#cfgEdgeKey') || {}).value || '';

        // If EDGE_KEY is provided, verify it against cloud first
        let agentId = '';
        if (edgeKeyValue) {
          setText(saveStatus, 'Verificando chave...');
          try {
            const verifyRes = await fetch('/v1/admin/verify-key', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ edgeKey: edgeKeyValue })
            });

            if (verifyRes.ok) {
              const info = await verifyRes.json();
              agentId = info.edgeKeyId || '';
              showEdgeInfo(info.name, info.labName);
            } else {
              const errBody = await verifyRes.json().catch(() => ({}));
              setText(saveStatus, 'Chave inv\u00e1lida: ' + (errBody.error || 'erro'));
              saveStatus.className = 'save-status error';
              hideEdgeInfo();
              saveBtn.disabled = false;
              setTimeout(() => { setText(saveStatus, ''); saveStatus.className = 'save-status'; }, 5000);
              return;
            }
          } catch (err) {
            // Cloud unreachable — save anyway, tunnel will validate on connect
            console.warn('Could not verify key:', err.message);
          }
        } else {
          hideEdgeInfo();
        }

        const payload = {
          cloud: {
            edgeKey: edgeKeyValue,
            agentId: agentId,
          },
          slidesDirHost: ($('#cfgSlidesDir') || {}).value || '',
          scanner: {
            type: ($('#cfgScannerType') || {}).value || 'unknown'
          },
          stableSeconds: parseInt(($('#cfgStableSeconds') || {}).value, 10) || 10,
          caseBaseRegex: undefined
        };

        try {
          const res = await fetch('/v1/admin/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });

          if (!res.ok) {
            const errBody = await res.json().catch(() => ({}));
            throw new Error(errBody.error || res.statusText);
          }

          const result = await res.json();
          setText(saveStatus, result.message || 'Salvo com sucesso!');
          saveStatus.className = 'save-status success';
        } catch (err) {
          setText(saveStatus, 'Erro: ' + err.message);
          saveStatus.className = 'save-status error';
        } finally {
          saveBtn.disabled = false;
          setTimeout(() => { setText(saveStatus, ''); saveStatus.className = 'save-status'; }, 5000);
        }
      });
    }
  }

  // =====================
  //  Edge Info helpers
  // =====================
  async function verifyAndShowEdgeInfo(edgeKey) {
    try {
      const res = await fetch('/v1/admin/verify-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edgeKey })
      });
      if (res.ok) {
        const info = await res.json();
        showEdgeInfo(info.name, info.labName);
      } else {
        hideEdgeInfo();
      }
    } catch {
      hideEdgeInfo();
    }
  }

  function showEdgeInfo(name, labName) {
    const container = $('#edgeInfo');
    if (!container) return;
    setText('#edgeInfoName', name || '--');
    setText('#edgeInfoLab', labName || '--');
    container.style.display = '';
  }

  function hideEdgeInfo() {
    const container = $('#edgeInfo');
    if (container) container.style.display = 'none';
  }

  // =====================
  //  Maintenance: Republish Previews
  // =====================
  function initMaintenance() {
    const btn = $('#btnRepublishPreviews');
    if (!btn) return;

    btn.addEventListener('click', async () => {
      const statusEl = $('#republishStatus');
      btn.disabled = true;
      setText(statusEl, 'Enfileirando...');
      statusEl.className = 'maintenance-status';

      try {
        const res = await fetch('/v1/admin/slides/republish-all-previews', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force: true }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || res.statusText);
        }

        const data = await res.json();
        setText(statusEl, data.message || `${data.queued} l\u00e2mina(s) enfileirada(s)`);
        statusEl.className = 'maintenance-status success';
      } catch (err) {
        setText(statusEl, 'Erro: ' + err.message);
        statusEl.className = 'maintenance-status error';
      } finally {
        btn.disabled = false;
        setTimeout(() => { setText(statusEl, ''); statusEl.className = 'maintenance-status'; }, 8000);
      }
    });
  }

  // =====================
  //  SSE (Server-Sent Events)
  // =====================
  function initSSE() {
    if (eventSource) {
      eventSource.close();
    }

    eventSource = new EventSource('/v1/events');

    eventSource.addEventListener('open', () => {
      setConnectionStatus(true);
    });

    // Named event: connected
    eventSource.addEventListener('connected', (e) => {
      setConnectionStatus(true);
      addActivityEvent('connected', safeParseJSON(e.data));
    });

    // Named event: slide:import
    eventSource.addEventListener('slide:import', (e) => {
      const data = safeParseJSON(e.data);
      addActivityEvent('slide:import', data);
      refreshAfterSlideEvent();
    });

    // Named event: slide:ready
    eventSource.addEventListener('slide:ready', (e) => {
      const data = safeParseJSON(e.data);
      addActivityEvent('slide:ready', data);
      refreshAfterSlideEvent();
    });

    // Named event: tile:pending
    eventSource.addEventListener('tile:pending', (e) => {
      const data = safeParseJSON(e.data);
      addActivityEvent('tile:pending', data);
    });

    // Named event: tile:generated
    eventSource.addEventListener('tile:generated', (e) => {
      const data = safeParseJSON(e.data);
      addActivityEvent('tile:generated', data);
    });

    // Named event: preview:published
    eventSource.addEventListener('preview:published', (e) => {
      const data = safeParseJSON(e.data);
      addActivityEvent('preview:published', data);
      refreshAfterSlideEvent();
    });

    // Named event: preview:failed
    eventSource.addEventListener('preview:failed', (e) => {
      const data = safeParseJSON(e.data);
      addActivityEvent('preview:failed', data);
    });

    // Generic message event (for any unnamed events)
    eventSource.addEventListener('message', (e) => {
      const data = safeParseJSON(e.data);
      if (data && data.event) {
        addActivityEvent(data.event, data);
      }
    });

    eventSource.addEventListener('error', () => {
      setConnectionStatus(false);
    });
  }

  function safeParseJSON(str) {
    try {
      return JSON.parse(str);
    } catch {
      return {};
    }
  }

  function setConnectionStatus(connected) {
    setDotClass('#connectionDot', connected ? 'connected' : 'disconnected');
    setText('#connectionText', connected ? 'Conectado' : 'Desconectado');
  }

  function refreshAfterSlideEvent() {
    // Refresh dashboard data
    fetchDashboard();
    // If slides tab is active, refresh slides too
    const slidesPanel = $('#panel-slides');
    if (slidesPanel && slidesPanel.classList.contains('active')) {
      fetchSlides();
    }
  }

  // =====================
  //  Initialization
  // =====================
  function init() {
    initTabs();
    initSlideFilters();
    initOcrModal();
    initActivityControls();
    initSettingsForm();
    initMaintenance();
    startDashboardPolling();
    initSSE();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
