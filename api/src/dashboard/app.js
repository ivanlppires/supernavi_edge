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
      if (tabId === 'failures') fetchFailures();
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

    // Failures tab badge
    const totalProblems = (data.slides && data.slides.withProblems) || 0;
    const stuckSync = (data.sync && data.sync.stuckCount) || 0;
    const totalIssues = totalProblems + stuckSync;
    const badge = $('#failuresBadge');
    if (badge) {
      if (totalIssues > 0) {
        badge.textContent = String(totalIssues);
        badge.style.display = '';
      } else {
        badge.style.display = 'none';
      }
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

    // Right section: status + time + reprocess button
    const right = el('div', { className: 'slide-right' });

    const statusBadge = el('span', { className: 'badge badge-' + (slide.status || 'queued') });
    statusBadge.textContent = statusLabel(slide.status);
    right.appendChild(statusBadge);

    const time = el('span', { className: 'slide-time' });
    time.textContent = relativeTime(slide.createdAt);
    right.appendChild(time);

    // Problem indicator (alert icon) — visible when slide has any pipeline issue
    const hasProblem =
      slide.status === 'failed' ||
      slide.latestError ||
      slide.cloudUploadStatus === 'failed' ||
      slide.tilegenStatus === 'failed';
    if (hasProblem) {
      const alertBtn = el('button', { className: 'slide-alert-btn' });
      alertBtn.title = slide.latestError || 'Lâmina com problema — clique para ver detalhes';
      alertBtn.setAttribute('aria-label', 'Ver detalhes do erro');
      alertBtn.textContent = 'Ver erro';
      alertBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openPipelineModal(slide.slideId, slide.originalFilename);
      });
      right.appendChild(alertBtn);
    }

    // Action buttons row
    const actions = el('div', { className: 'slide-actions' });

    // Re-process button: show for ready/failed WSI slides that have a raw file
    const isWSI = ['svs', 'tiff', 'ndpi', 'mrxs'].includes((slide.format || '').toLowerCase());
    const canReprocess = isWSI && slide.hasRawFile && ['ready', 'failed'].includes(slide.status);
    if (canReprocess) {
      const btn = el('button', { className: 'btn-reprocess' });
      btn.textContent = 'Re-processar';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        reprocessSlide(slide.slideId, btn);
      });
      actions.appendChild(btn);
    }

    // Delete button
    const delBtn = el('button', { className: 'btn-delete' });
    delBtn.textContent = 'Excluir';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSlide(slide.slideId, slide.originalFilename, card);
    });
    actions.appendChild(delBtn);

    right.appendChild(actions);
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

  async function reprocessSlide(slideId, btn) {
    btn.disabled = true;
    btn.textContent = 'Enviando...';

    try {
      const res = await fetch('/v1/slides/' + encodeURIComponent(slideId) + '/reprocess', {
        method: 'POST',
      });
      const data = await res.json();

      if (res.ok && data.success) {
        btn.textContent = 'Na fila';
        btn.classList.add('btn-reprocess-sent');
        // Update the card status visually
        const card = btn.closest('.slide-card');
        if (card) {
          card.setAttribute('data-status', 'processing');
          const badge = card.querySelector('.badge-ready, .badge-failed');
          if (badge) {
            badge.className = 'badge badge-processing';
            badge.textContent = 'Processando';
          }
        }
        // Refresh slides list after a short delay
        setTimeout(fetchSlides, 2000);
      } else {
        btn.textContent = data.error || 'Erro';
        btn.classList.add('btn-reprocess-error');
        setTimeout(() => {
          btn.disabled = false;
          btn.textContent = 'Re-processar';
          btn.classList.remove('btn-reprocess-error');
        }, 3000);
      }
    } catch (err) {
      btn.textContent = 'Erro de rede';
      btn.classList.add('btn-reprocess-error');
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = 'Re-processar';
        btn.classList.remove('btn-reprocess-error');
      }, 3000);
    }
  }

  async function deleteSlide(slideId, filename, card) {
    const msg = `Excluir lâmina "${filename}"?\n\nIsso apaga banco, raw, derivados e agenda limpeza S3.`;
    if (!confirm(msg)) return;

    // Visual feedback
    card.style.opacity = '0.5';
    card.style.pointerEvents = 'none';

    try {
      const res = await fetch('/v1/slides/' + encodeURIComponent(slideId), {
        method: 'DELETE',
      });
      const data = await res.json();

      if (res.ok && data.success) {
        card.style.transition = 'opacity 0.3s ease, max-height 0.3s ease, margin 0.3s ease, padding 0.3s ease';
        card.style.opacity = '0';
        card.style.maxHeight = '0';
        card.style.margin = '0';
        card.style.padding = '0';
        card.style.overflow = 'hidden';
        setTimeout(() => card.remove(), 350);
      } else {
        card.style.opacity = '1';
        card.style.pointerEvents = '';
        alert(data.error || 'Erro ao excluir lâmina');
      }
    } catch (err) {
      card.style.opacity = '1';
      card.style.pointerEvents = '';
      alert('Erro de rede ao excluir lâmina');
    }
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
  let ocrSlidesList = [];
  let ocrCurrentIndex = -1;

  // Client-side OCR parse (mirrors backend parseOcrResponse)
  function parseOcrInput(text) {
    if (!text || typeof text !== 'string') return null;
    const trimmed = text.trim().toUpperCase();
    if (!trimmed) return null;

    // Abbreviated format: 26_388A or 26-388A → AP26000388A
    const abbrMatch = trimmed.match(/^(\d{2})[-_](\d{1,6})([A-Z]\d*)?$/i);
    if (abbrMatch) {
      let left = abbrMatch[1];
      const right = abbrMatch[2];
      const suffix = (abbrMatch[3] || '').toUpperCase();
      // Year correction: 9↔2 (handwritten misread)
      const currentYY = new Date().getFullYear() % 100;
      const yr = parseInt(left, 10);
      if (yr < 20 || yr > currentYY) {
        const corrections = { '9': '2', '2': '9' };
        for (let i = 0; i < left.length; i++) {
          const r = corrections[left[i]];
          if (!r) continue;
          const c = left.substring(0, i) + r + left.substring(i + 1);
          const cy = parseInt(c, 10);
          if (cy >= 20 && cy <= currentYY) { left = c; break; }
        }
      }
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
    const prevBtn = $('#ocrPrev');
    const nextBtn = $('#ocrNext');

    if (closeBtn) closeBtn.addEventListener('click', closeOcrModal);
    if (closeBtn2) closeBtn2.addEventListener('click', closeOcrModal);

    if (overlay) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeOcrModal();
      });
    }

    document.addEventListener('keydown', (e) => {
      if (!currentOcrSlideId) return;
      if (e.key === 'Escape') closeOcrModal();
      if (e.key === 'ArrowLeft') navigateOcrSlide(-1);
      if (e.key === 'ArrowRight') navigateOcrSlide(1);
    });

    if (reocrBtn) reocrBtn.addEventListener('click', triggerReocr);
    if (prevBtn) prevBtn.addEventListener('click', () => navigateOcrSlide(-1));
    if (nextBtn) nextBtn.addEventListener('click', () => navigateOcrSlide(1));

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

      // Prevent arrow keys from navigating slides when typing
      manualInput.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') e.stopPropagation();
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

    // Build navigation list (slides with labels)
    ocrSlidesList = slidesData.filter(s => s.hasLabel);
    ocrCurrentIndex = ocrSlidesList.findIndex(s => s.slideId === slide.slideId);
    if (ocrCurrentIndex === -1) {
      // Slide not in filtered list — add it temporarily
      ocrSlidesList = [slide];
      ocrCurrentIndex = 0;
    }

    currentOcrSlideId = slide.slideId;
    const slideUrl = '/v1/slides/' + encodeURIComponent(slide.slideId);

    // Update navigation counter and buttons
    updateOcrNav();

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

  function updateOcrNav() {
    const counter = $('#ocrNavCounter');
    const prevBtn = $('#ocrPrev');
    const nextBtn = $('#ocrNext');

    if (counter) counter.textContent = (ocrCurrentIndex + 1) + ' / ' + ocrSlidesList.length;
    if (prevBtn) prevBtn.disabled = ocrCurrentIndex <= 0;
    if (nextBtn) nextBtn.disabled = ocrCurrentIndex >= ocrSlidesList.length - 1;
  }

  function navigateOcrSlide(delta) {
    const newIndex = ocrCurrentIndex + delta;
    if (newIndex < 0 || newIndex >= ocrSlidesList.length) return;
    // Use fresh data from slidesData if available
    const target = ocrSlidesList[newIndex];
    const fresh = slidesData.find(s => s.slideId === target.slideId);
    openOcrModal(fresh || target);
  }

  function closeOcrModal() {
    const overlay = $('#ocrModal');
    if (overlay) overlay.classList.remove('visible');
    currentOcrSlideId = null;
    ocrSlidesList = [];
    ocrCurrentIndex = -1;
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
      case 'slide:failed':
        return 'Falha no processamento (' + (data && data.stage || '?') + '): ' + (data && data.error || 'erro');
      case 'pipeline:error':
        return 'Erro em ' + (data && data.stage || '?') + ': ' + (data && data.message || '');
      case 'ingest:failed':
        return 'Falha na ingest\u00e3o: ' + (data && data.filename || '') + ' \u2014 ' + (data && data.error || '');
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
    if (eventType === 'slide:failed' || eventType === 'pipeline:error' || eventType === 'ingest:failed') return 'error';
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

    // Named event: slide:failed (emitted when TILEGEN/BIGTIFF/job-level fails)
    eventSource.addEventListener('slide:failed', (e) => {
      const data = safeParseJSON(e.data);
      addActivityEvent('slide:failed', data);
      refreshAfterSlideEvent();
      // Refresh failures tab if active
      const failPanel = $('#panel-failures');
      if (failPanel && failPanel.classList.contains('active')) fetchFailures();
    });

    // Named event: pipeline:error (any stage error logged via pipelineLog)
    eventSource.addEventListener('pipeline:error', (e) => {
      const data = safeParseJSON(e.data);
      addActivityEvent('pipeline:error', data);
      const failPanel = $('#panel-failures');
      if (failPanel && failPanel.classList.contains('active')) fetchFailures();
    });

    // Named event: ingest:failed (file copy/hash error before slide row exists)
    eventSource.addEventListener('ingest:failed', (e) => {
      const data = safeParseJSON(e.data);
      addActivityEvent('ingest:failed', data);
    });

    // Named event: pending:count-changed (review queue)
    eventSource.addEventListener('pending:count-changed', (e) => {
      const data = safeParseJSON(e.data);
      if (data && typeof data.count === 'number') updatePendingBadge(data.count);
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
  //  Tab: Failures
  // =====================
  function stageLabel(stage) {
    const labels = {
      ingest: 'Ingestão',
      p0: 'P0 (thumbnail)',
      p1: 'P1 (níveis extras)',
      tilegen: 'Geração de tiles',
      bigtiff: 'BigTIFF',
      cloud_upload: 'Upload para nuvem',
      outbox: 'Outbox',
      sync: 'Sincronização',
      preview: 'Preview',
      cleanup: 'Limpeza',
      unknown: 'Desconhecido'
    };
    return labels[stage] || stage;
  }

  function severityClass(sev) {
    if (sev === 'critical') return 'sev-critical';
    if (sev === 'warning') return 'sev-warning';
    return 'sev-info';
  }

  function actionLabel(action) {
    const labels = {
      reprocess: 'Re-processar',
      redigitalize: 'Redigitalizar',
      check_disk: 'Verificar disco',
      check_credentials: 'Verificar credenciais',
      check_cloud: 'Verificar nuvem',
      wait_retry: 'Aguardar retry',
      check_logs: 'Verificar logs',
      manual: 'Manual'
    };
    return labels[action] || action;
  }

  async function fetchFailures() {
    try {
      const res = await fetch('/v1/dashboard/failures');
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      renderFailures(data);
    } catch (err) {
      console.error('Failures fetch error:', err);
    }
  }

  function renderFailures(data) {
    const list = $('#failuresList');
    const empty = $('#failuresEmpty');
    const subtitle = $('#failuresSubtitle');
    const stuckSection = $('#stuckSyncSection');
    const stuckList = $('#stuckSyncList');

    // Clear existing failure cards (keep empty state)
    list.querySelectorAll('.failure-card').forEach(c => c.remove());

    const failures = data.failures || [];
    setText(subtitle, failures.length === 0
      ? 'Tudo em ordem'
      : (failures.length + (failures.length === 1 ? ' lâmina afetada' : ' lâminas afetadas')));

    if (failures.length === 0) {
      if (empty) empty.style.display = '';
    } else {
      if (empty) empty.style.display = 'none';
      for (const f of failures) {
        list.appendChild(buildFailureCard(f));
      }
    }

    // Stuck sync events
    const stuck = data.stuckSync || [];
    if (stuckList) clearChildren(stuckList);
    if (stuck.length > 0) {
      stuckSection.style.display = '';
      for (const s of stuck) {
        stuckList.appendChild(buildStuckSyncCard(s));
      }
    } else {
      stuckSection.style.display = 'none';
    }
  }

  function buildFailureCard(failure) {
    const card = el('div', { className: 'failure-card ' + severityClass(failure.advice?.severity) });

    const header = el('div', { className: 'failure-card-header' });
    const filename = el('div', { className: 'failure-filename' });
    filename.textContent = failure.originalFilename || failure.slideId.substring(0, 12);
    header.appendChild(filename);

    const stageBadge = el('span', { className: 'failure-stage-badge' });
    stageBadge.textContent = stageLabel(failure.stage);
    header.appendChild(stageBadge);

    const time = el('span', { className: 'failure-time' });
    time.textContent = relativeTime(failure.errorAt);
    header.appendChild(time);

    card.appendChild(header);

    const reason = el('div', { className: 'failure-reason' });
    reason.textContent = failure.advice?.reason || failure.message || 'Erro desconhecido';
    card.appendChild(reason);

    if (failure.advice?.suggestion) {
      const suggestion = el('div', { className: 'failure-suggestion' });
      const label = el('span', { className: 'failure-suggestion-label' });
      label.textContent = 'Sugestão: ';
      suggestion.appendChild(label);
      suggestion.appendChild(document.createTextNode(failure.advice.suggestion));
      card.appendChild(suggestion);
    }

    const errMsg = el('div', { className: 'failure-error-msg' });
    errMsg.textContent = failure.message || '--';
    card.appendChild(errMsg);

    // Actions
    const actions = el('div', { className: 'failure-actions' });
    const detailsBtn = el('button', { className: 'btn-failure-details' });
    detailsBtn.textContent = 'Ver timeline';
    detailsBtn.addEventListener('click', () => {
      openPipelineModal(failure.slideId, failure.originalFilename);
    });
    actions.appendChild(detailsBtn);

    const advAction = failure.advice?.action;
    if (advAction === 'reprocess') {
      const rpBtn = el('button', { className: 'btn-failure-action' });
      rpBtn.textContent = 'Re-processar';
      rpBtn.addEventListener('click', () => reprocessSlide(failure.slideId, rpBtn));
      actions.appendChild(rpBtn);
    } else if (advAction) {
      const tag = el('span', { className: 'failure-action-tag' });
      tag.textContent = actionLabel(advAction);
      actions.appendChild(tag);
    }

    card.appendChild(actions);
    return card;
  }

  function buildStuckSyncCard(stuck) {
    const card = el('div', { className: 'failure-card sev-warning' });
    const header = el('div', { className: 'failure-card-header' });
    const title = el('div', { className: 'failure-filename' });
    title.textContent = (stuck.entityType || 'event') + ': ' + (stuck.entityId || '').substring(0, 24);
    header.appendChild(title);

    const time = el('span', { className: 'failure-time' });
    time.textContent = relativeTime(stuck.lastAttemptAt || stuck.createdAt);
    header.appendChild(time);
    card.appendChild(header);

    const reason = el('div', { className: 'failure-reason' });
    reason.textContent = stuck.reason
      ? `Cloud rejeitou (${stuck.attempts} tentativa${stuck.attempts === 1 ? '' : 's'}): ${stuck.reason}`
      : 'Evento aguardando sincronização há mais de 5 minutos';
    card.appendChild(reason);

    if (stuck.entityType === 'slide' || stuck.entityType === 'preview') {
      const slideId = stuck.entityType === 'slide'
        ? stuck.entityId
        : (stuck.entityId || '').replace(/^preview:/, '');
      if (slideId) {
        const actions = el('div', { className: 'failure-actions' });
        const btn = el('button', { className: 'btn-failure-details' });
        btn.textContent = 'Ver timeline';
        btn.addEventListener('click', () => openPipelineModal(slideId, slideId.substring(0, 12)));
        actions.appendChild(btn);
        card.appendChild(actions);
      }
    }

    return card;
  }

  function initFailuresControls() {
    const btn = $('#refreshFailures');
    if (btn) btn.addEventListener('click', fetchFailures);
  }

  // =====================
  //  Pipeline Timeline Modal
  // =====================
  function openPipelineModal(slideId, filenameHint) {
    const overlay = $('#pipelineModal');
    const title = $('#pipelineModalTitle');
    const subtitle = $('#pipelineModalSubtitle');
    const body = $('#pipelineModalBody');
    if (!overlay) return;

    setText(title, 'Timeline da Lâmina');
    setText(subtitle, filenameHint || slideId.substring(0, 16));
    clearChildren(body);
    body.appendChild(el('div', { className: 'pipeline-loading', textContent: 'Carregando...' }));

    overlay.classList.add('active');

    fetch('/v1/slides/' + encodeURIComponent(slideId) + '/pipeline')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(r.statusText)))
      .then(data => renderPipelineTimeline(data))
      .catch(err => {
        clearChildren(body);
        body.appendChild(el('div', { className: 'pipeline-error',
          textContent: 'Erro ao carregar: ' + err.message }));
      });
  }

  function closePipelineModal() {
    const overlay = $('#pipelineModal');
    if (overlay) overlay.classList.remove('active');
  }

  function renderPipelineTimeline(data) {
    const body = $('#pipelineModalBody');
    const subtitle = $('#pipelineModalSubtitle');
    if (!body) return;

    setText(subtitle, (data.slide.originalFilename || data.slide.slideId.substring(0, 16))
      + ' — ' + (data.slide.format || '?').toUpperCase()
      + ' — status: ' + statusLabel(data.slide.status));

    clearChildren(body);

    // Advice block
    if (data.advice) {
      const advBox = el('div', { className: 'pipeline-advice ' + severityClass(data.advice.severity) });
      const advTitle = el('div', { className: 'pipeline-advice-title' });
      advTitle.textContent = '⚠ ' + data.advice.reason;
      advBox.appendChild(advTitle);
      const advSug = el('div', { className: 'pipeline-advice-suggestion' });
      advSug.textContent = data.advice.suggestion;
      advBox.appendChild(advSug);
      body.appendChild(advBox);
    }

    // Timeline of events
    const eventsTitle = el('h3', { className: 'pipeline-section-title', textContent: 'Eventos do pipeline' });
    body.appendChild(eventsTitle);

    if (!data.events || data.events.length === 0) {
      body.appendChild(el('div', { className: 'pipeline-empty',
        textContent: 'Nenhum evento registrado para esta lâmina.' }));
    } else {
      const tl = el('div', { className: 'pipeline-timeline' });
      for (const ev of data.events) {
        const item = el('div', { className: 'pipeline-event level-' + ev.level });
        const dot = el('span', { className: 'pipeline-event-dot' });
        item.appendChild(dot);

        const content = el('div', { className: 'pipeline-event-content' });
        const stage = el('span', { className: 'pipeline-event-stage' });
        stage.textContent = stageLabel(ev.stage);
        content.appendChild(stage);

        const msg = el('div', { className: 'pipeline-event-message' });
        msg.textContent = ev.message || '(sem mensagem)';
        content.appendChild(msg);

        if (ev.details) {
          const det = el('pre', { className: 'pipeline-event-details' });
          try {
            det.textContent = JSON.stringify(ev.details, null, 2);
          } catch {
            det.textContent = String(ev.details);
          }
          content.appendChild(det);
        }

        item.appendChild(content);

        const time = el('span', { className: 'pipeline-event-time' });
        const d = new Date(ev.createdAt);
        time.textContent = formatTime(d) + ' · ' + relativeTime(ev.createdAt);
        item.appendChild(time);

        tl.appendChild(item);
      }
      body.appendChild(tl);
    }

    // Jobs list
    if (data.jobs && data.jobs.length > 0) {
      body.appendChild(el('h3', { className: 'pipeline-section-title', textContent: 'Jobs' }));
      const jobsTable = el('div', { className: 'pipeline-jobs' });
      for (const j of data.jobs) {
        const row = el('div', { className: 'pipeline-job-row status-' + j.status });
        const left = el('div');
        left.textContent = j.type;
        const status = el('span', { className: 'pipeline-job-status' });
        status.textContent = j.status;
        const time = el('span', { className: 'pipeline-job-time' });
        time.textContent = relativeTime(j.updatedAt || j.createdAt);
        row.appendChild(left);
        row.appendChild(status);
        row.appendChild(time);
        if (j.error) {
          const err = el('div', { className: 'pipeline-job-error' });
          err.textContent = j.error;
          row.appendChild(err);
        }
        jobsTable.appendChild(row);
      }
      body.appendChild(jobsTable);
    }

    // Sync failures
    if (data.syncFailures && data.syncFailures.length > 0) {
      body.appendChild(el('h3', { className: 'pipeline-section-title',
        textContent: 'Falhas de sincronização' }));
      for (const sf of data.syncFailures) {
        const row = el('div', { className: 'pipeline-sync-failure' });
        const head = el('div');
        head.textContent = sf.entityType + ' · ' + sf.attempts + ' tentativa(s)' +
          (sf.isPermanent ? ' · permanente' : '');
        row.appendChild(head);
        const r = el('div', { className: 'pipeline-sync-reason' });
        r.textContent = sf.reason || '(sem motivo)';
        row.appendChild(r);
        body.appendChild(row);
      }
    }
  }

  function initPipelineModal() {
    const overlay = $('#pipelineModal');
    const closeBtn = $('#pipelineModalClose');
    if (closeBtn) closeBtn.addEventListener('click', closePipelineModal);
    if (overlay) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closePipelineModal();
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay && overlay.classList.contains('active')) {
        closePipelineModal();
      }
    });
  }

  // === Review queue (Tasks 11-14) ============================
  // Single async IIFE: capability check gates ALL wiring. When the feature is
  // disabled, removes badge/panel/modal from DOM and returns — nothing else
  // attaches, nothing fetches /v1/pending-slides.
  (async () => {
    let reviewQueueEnabled = false;
    try {
      const r = await fetch('/v1/capabilities');
      if (r.ok) {
        const caps = await r.json();
        reviewQueueEnabled = caps?.features?.review_queue === true;
      }
    } catch (err) {
      console.warn('Failed to check review_queue capability:', err);
    }

    if (!reviewQueueEnabled) {
      ['pendingBadge', 'pendingPanel', 'reviewModal'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.remove();
      });
      return;
    }

  // =====================
  //  Review queue: pending badge (Task 11)
  // =====================
  const pendingBadge = document.getElementById('pendingBadge');
  const pendingCountEl = document.getElementById('pendingCount');

  function updatePendingBadge(count) {
    if (!pendingBadge || !pendingCountEl) return;
    pendingCountEl.textContent = String(count);
    pendingBadge.classList.toggle('hidden', count === 0);
  }

  // Initial fetch on page load — defensive: check r.ok before parsing
  fetch('/v1/pending-slides')
    .then(r => r.ok ? r.json() : null)
    .then(d => { if (d && typeof d.total === 'number') updatePendingBadge(d.total); })
    .catch(() => {});

  if (pendingBadge) {
    pendingBadge.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('open-pending-panel'));
    });
    pendingBadge.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('open-pending-panel'));
      }
    });
  }

  // === Review queue: notification panel ============================
  const pendingPanel = document.getElementById('pendingPanel');
  const pendingPanelList = document.getElementById('pendingPanelList');
  const pendingPanelCount = document.getElementById('pendingPanelCount');
  const pendingPanelClose = document.getElementById('pendingPanelClose');
  const pendingPanelOpenAll = document.getElementById('pendingPanelOpenAll');

  function buildPendingPanelItem(slide) {
    const li = document.createElement('li');
    li.className = 'pending-panel__item';
    li.dataset.slideId = slide.id;

    const proposed = document.createElement('div');
    proposed.className = 'proposed';
    proposed.textContent = slide.proposed_name || '(sem sugestão)';
    li.appendChild(proposed);

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = slide.original_filename || '';
    li.appendChild(meta);

    li.addEventListener('click', () => {
      pendingPanel.classList.add('hidden');
      document.dispatchEvent(new CustomEvent('open-review-modal', { detail: { slideId: slide.id } }));
    });
    return li;
  }

  async function renderPendingPanel() {
    if (!pendingPanel) return;
    try {
      const r = await fetch('/v1/pending-slides');
      if (!r.ok) return;
      const data = await r.json();
      pendingPanelCount.textContent = String(data.total);
      // Safe wipe: emptying via removeChild loop (no innerHTML).
      while (pendingPanelList.firstChild) pendingPanelList.removeChild(pendingPanelList.firstChild);
      for (const s of data.slides.slice(0, 5)) {
        pendingPanelList.appendChild(buildPendingPanelItem(s));
      }
    } catch (err) {
      console.warn('Failed to render pending panel:', err);
    }
  }

  if (pendingPanel) {
    document.addEventListener('open-pending-panel', () => {
      pendingPanel.classList.remove('hidden');
      renderPendingPanel();
    });

    if (pendingPanelClose) {
      pendingPanelClose.addEventListener('click', () => pendingPanel.classList.add('hidden'));
    }

    if (pendingPanelOpenAll) {
      pendingPanelOpenAll.addEventListener('click', () => {
        pendingPanel.classList.add('hidden');
        document.dispatchEvent(new CustomEvent('open-review-modal', { detail: { slideId: null } }));
      });
    }

    // Close on outside click (but not when clicking the badge that opened it).
    document.addEventListener('click', (e) => {
      if (pendingPanel.classList.contains('hidden')) return;
      if (pendingPanel.contains(e.target)) return;
      if (e.target.closest && e.target.closest('#pendingBadge')) return;
      pendingPanel.classList.add('hidden');
    });

    // Close on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !pendingPanel.classList.contains('hidden')) {
        pendingPanel.classList.add('hidden');
      }
    });
  }

  // === Review queue: modal (Tasks 13+14) =========================
  const reviewModal = document.getElementById('reviewModal');
  const reviewModalClose = document.getElementById('reviewModalClose');
  const reviewImage = document.getElementById('reviewImage');
  const reviewImageEmpty = document.getElementById('reviewImageEmpty');
  const reviewImageToggle = document.querySelectorAll('.review-modal__image-toggle button');
  const reviewFilename = document.getElementById('reviewFilename');
  const reviewFilenameHint = document.getElementById('reviewFilenameHint');
  const reviewFilenameError = document.getElementById('reviewFilenameError');
  const reviewConfirm = document.getElementById('reviewConfirm');
  const reviewContextSection = document.getElementById('reviewContextSection');

  let currentSlideId = null;
  let currentImageWhich = 'label';

  const FILENAME_RE = /^(AP|PA|IM|C)\d{6,12}[A-Z]?\d*$/;

  function loadImage(slideId, which) {
    if (!reviewImage || !reviewImageEmpty) return;
    reviewImageEmpty.classList.add('hidden');
    reviewImage.classList.remove('hidden');
    reviewImage.src = '/v1/pending-slides/' + encodeURIComponent(slideId) + '/image?which=' + encodeURIComponent(which);
    reviewImage.onerror = () => {
      reviewImage.classList.add('hidden');
      reviewImageEmpty.classList.remove('hidden');
      // `which` is hardcoded to 'label' or 'slide2' — safe in a template string.
      reviewImageEmpty.textContent = which + '.jpg indisponível';
    };
  }

  if (reviewImageToggle && reviewImageToggle.length) {
    reviewImageToggle.forEach(btn => {
      btn.addEventListener('click', () => {
        reviewImageToggle.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentImageWhich = btn.dataset.which;
        loadImage(currentSlideId, currentImageWhich);
      });
    });
  }

  function closeReviewModal() {
    if (!reviewModal) return;
    reviewModal.classList.add('hidden');
    currentSlideId = null;
  }

  if (reviewModalClose) {
    reviewModalClose.addEventListener('click', closeReviewModal);
  }

  // renderContextSection is defined in Task 14; guard the call.
  async function safeRenderContextSection() {
    if (typeof renderContextSection === 'function') {
      try { await renderContextSection(); } catch (err) { console.warn(err); }
    } else {
      // Clear the section so an old context from a prior open doesn't linger.
      if (reviewContextSection) {
        while (reviewContextSection.firstChild) reviewContextSection.removeChild(reviewContextSection.firstChild);
      }
    }
  }

  async function openReview(slideId) {
    if (!reviewModal) return;
    currentSlideId = slideId;
    currentImageWhich = 'label';
    if (reviewImageToggle && reviewImageToggle.length) {
      reviewImageToggle.forEach(b => b.classList.toggle('active', b.dataset.which === 'label'));
    }

    try {
      const r = await fetch('/v1/pending-slides');
      if (!r.ok) { closeReviewModal(); return; }
      const data = await r.json();
      const slide = data.slides.find(s => s.id === slideId) || data.slides[0];
      if (!slide) { closeReviewModal(); return; }
      currentSlideId = slide.id;

      reviewFilename.value = slide.proposed_name || '';
      reviewFilenameHint.textContent = slide.proposed_name ? 'Sugestão IA' : 'Sem sugestão';
      validateFilename();
      await safeRenderContextSection();

      loadImage(currentSlideId, currentImageWhich);
      reviewModal.classList.remove('hidden');
      reviewFilename.focus();
    } catch (err) {
      console.warn('Failed to open review modal:', err);
    }
  }

  function validateFilename() {
    if (!reviewFilename || !reviewConfirm) return false;
    const ok = FILENAME_RE.test(reviewFilename.value.trim());
    reviewConfirm.disabled = !ok;
    if (reviewFilenameError) {
      reviewFilenameError.classList.toggle('hidden', ok);
      if (!ok) reviewFilenameError.textContent = 'Formato esperado: AP/PA/IM/C + 6-12 dígitos + opcional letra/dígitos';
    }
    return ok;
  }

  if (reviewFilename) {
    reviewFilename.addEventListener('input', async () => {
      validateFilename();
      await safeRenderContextSection();
    });
  }

  if (reviewModal) {
    document.addEventListener('open-review-modal', async (e) => {
      let slideId = e.detail && e.detail.slideId;
      if (!slideId) {
        try {
          const r = await fetch('/v1/pending-slides');
          if (!r.ok) return;
          const data = await r.json();
          if (data.slides.length === 0) return;
          slideId = data.slides[0].id;
        } catch (err) {
          console.warn('Failed to fetch pending slides:', err);
          return;
        }
      }
      await openReview(slideId);
    });
  }

  // === Review queue: context form helpers (Task 14) ================
  const SUBTIPO_SUGGESTIONS = [
    'biopsia_pele', 'biopsia_gastrica', 'biopsia_intestinal',
    'biopsia_prostatica', 'biopsia_mamaria', 'biopsia_hepatica',
    'citologia_cervical', 'citologia_urinaria', 'puncao_aspirativa',
  ];

  function examTypeFromCaseBase(caseBase) {
    if (!caseBase) return '';
    if (caseBase.startsWith('C')) return 'CITO';
    return 'AP';
  }

  function caseBaseFromInput(value) {
    const v = (value || '').toUpperCase().replace(/[\s\-_.]/g, '');
    const m = v.match(/^((?:AP|PA|IM|C)\d{6,12})/);
    if (!m) return null;
    return m[1].replace(/^PA/, 'AP');
  }

  function makeField(labelText, inputEl, hintText) {
    const label = document.createElement('label');
    label.className = 'review-field';
    const span = document.createElement('span');
    span.textContent = labelText;
    label.appendChild(span);
    label.appendChild(inputEl);
    if (hintText) {
      const small = document.createElement('small');
      small.textContent = hintText;
      label.appendChild(small);
    }
    return label;
  }

  function buildExistingContextBlock(caseBase, ctx) {
    const wrap = document.createElement('div');
    wrap.className = 'context-existing';

    const heading = document.createElement('strong');
    heading.textContent = `Contexto já preenchido para ${caseBase}`;
    wrap.appendChild(heading);

    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Ver contexto';
    details.appendChild(summary);

    const dl = document.createElement('dl');
    const rows = [
      ['examType', ctx.exam_type],
      ['subtipo', ctx.subtipo],
      ['sexo / idade', `${ctx.sexo} · ${ctx.idade}a`],
      ['material', ctx.material],
      ['hipótese', ctx.hipotese || '(vazio)'],
    ];
    for (const [k, v] of rows) {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      dl.appendChild(dt); dl.appendChild(dd);
    }
    details.appendChild(dl);
    wrap.appendChild(details);
    return wrap;
  }

  function buildNewContextForm(caseBase) {
    const wrap = document.createElement('div');
    wrap.className = 'context-form';

    const heading = document.createElement('strong');
    heading.textContent = `Contexto do caso ${caseBase} · novo`;
    wrap.appendChild(heading);

    const grid = document.createElement('div');
    grid.className = 'context-grid';

    const examSelect = document.createElement('select');
    examSelect.id = 'ctxExamType';
    for (const v of ['AP', 'CITO']) {
      const opt = document.createElement('option');
      opt.value = v; opt.textContent = v;
      if (v === examTypeFromCaseBase(caseBase)) opt.selected = true;
      examSelect.appendChild(opt);
    }
    grid.appendChild(makeField('examType', examSelect));

    const sexoSelect = document.createElement('select');
    sexoSelect.id = 'ctxSexo';
    for (const v of ['F', 'M', 'outro']) {
      const opt = document.createElement('option');
      opt.value = v; opt.textContent = v;
      sexoSelect.appendChild(opt);
    }
    grid.appendChild(makeField('sexo', sexoSelect));

    const idadeInput = document.createElement('input');
    idadeInput.type = 'number'; idadeInput.min = '0'; idadeInput.max = '130';
    idadeInput.id = 'ctxIdade';
    grid.appendChild(makeField('idade', idadeInput));

    wrap.appendChild(grid);

    const subtipoInput = document.createElement('input');
    subtipoInput.type = 'text'; subtipoInput.id = 'ctxSubtipo';
    subtipoInput.setAttribute('list', 'subtipoSugestoes');
    subtipoInput.placeholder = 'ex: biopsia_pele';
    wrap.appendChild(makeField('subtipo', subtipoInput));

    let datalist = document.getElementById('subtipoSugestoes');
    if (!datalist) {
      datalist = document.createElement('datalist');
      datalist.id = 'subtipoSugestoes';
      for (const s of SUBTIPO_SUGGESTIONS) {
        const opt = document.createElement('option');
        opt.value = s;
        datalist.appendChild(opt);
      }
      document.body.appendChild(datalist);
    }

    const materialTa = document.createElement('textarea');
    materialTa.id = 'ctxMaterial'; materialTa.rows = 2;
    materialTa.placeholder = 'ex: Biópsia de pele - região torácica';
    wrap.appendChild(makeField('material', materialTa));

    const hipoteseTa = document.createElement('textarea');
    hipoteseTa.id = 'ctxHipotese'; hipoteseTa.rows = 2;
    hipoteseTa.placeholder = 'Suspeita clínica';
    wrap.appendChild(makeField('hipótese (opcional)', hipoteseTa));

    return wrap;
  }

  async function renderContextSection() {
    if (!reviewContextSection || !reviewFilename) return;
    const caseBase = caseBaseFromInput(reviewFilename.value);
    clearChildren(reviewContextSection);
    if (!caseBase) return;

    try {
      const r = await fetch(`/v1/case-contexts/${encodeURIComponent(caseBase)}`);
      if (r.status === 200) {
        const ctx = await r.json();
        reviewContextSection.appendChild(buildExistingContextBlock(caseBase, ctx));
      } else {
        reviewContextSection.appendChild(buildNewContextForm(caseBase));
      }
    } catch (err) {
      console.warn('Failed to render context section:', err);
      reviewContextSection.appendChild(buildNewContextForm(caseBase));
    }
  }

  function readContextFromForm() {
    const subtipo = document.getElementById('ctxSubtipo');
    if (!subtipo) return null; // existing-context view, nothing to send
    const material = document.getElementById('ctxMaterial').value.trim();
    const idade = parseInt(document.getElementById('ctxIdade').value, 10);
    if (!subtipo.value.trim() || !material || !Number.isFinite(idade)) {
      throw new Error('Preencha examType, subtipo, sexo, idade e material.');
    }
    return {
      exam_type: document.getElementById('ctxExamType').value,
      subtipo: subtipo.value.trim(),
      sexo: document.getElementById('ctxSexo').value,
      idade,
      material,
      hipotese: document.getElementById('ctxHipotese').value.trim() || null,
    };
  }

  // === Review queue: confirm / rescan wiring (Task 14) =============
  async function loadNextOrClose() {
    try {
      const r = await fetch('/v1/pending-slides');
      if (!r.ok) { closeReviewModal(); return; }
      const next = await r.json();
      if (next.slides.length > 0) await openReview(next.slides[0].id);
      else closeReviewModal();
    } catch (err) {
      console.warn('Failed to load next pending slide:', err);
      closeReviewModal();
    }
  }

  if (reviewConfirm) {
    reviewConfirm.addEventListener('click', async () => {
      if (!validateFilename()) return;
      let clinicalContext = null;
      try {
        clinicalContext = readContextFromForm();
      } catch (err) {
        alert(err.message);
        return;
      }
      reviewConfirm.disabled = true;
      try {
        const res = await fetch(`/v1/pending-slides/${encodeURIComponent(currentSlideId)}/confirm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename: reviewFilename.value.trim().toUpperCase(),
            clinicalContext: clinicalContext || undefined,
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        await loadNextOrClose();
      } catch (err) {
        alert(`Erro ao confirmar: ${err.message}`);
        reviewConfirm.disabled = false;
      }
    });
  }

  const reviewRescan = document.getElementById('reviewRescan');
  if (reviewRescan) {
    reviewRescan.addEventListener('click', async () => {
      if (!confirm('Marcar esta lâmina como rescanear?')) return;
      try {
        await fetch(`/v1/pending-slides/${encodeURIComponent(currentSlideId)}/rescan`, { method: 'POST' });
        await loadNextOrClose();
      } catch (err) {
        alert(`Erro: ${err.message}`);
      }
    });
  }

  if (reviewModal) {
    reviewModal.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        if (reviewConfirm && !reviewConfirm.disabled) reviewConfirm.click();
      }
      if (e.key === 'Escape') closeReviewModal();
    });
  }

  })(); // end review-queue async IIFE

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
    initFailuresControls();
    initPipelineModal();
    startDashboardPolling();
    initSSE();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
