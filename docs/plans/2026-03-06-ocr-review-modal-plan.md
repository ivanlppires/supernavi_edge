# OCR Review Modal with Manual Edit — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expand the OCR modal so technicians can visually verify OCR results against the source image, re-trigger OCR, and manually correct the slide name with real-time validation.

**Architecture:** Add two backend endpoints (GET slide2 image, POST manual rename), expand the HTML modal with image tabs and an inline edit form, add frontend parse logic mirroring the backend parser, and style the new components to match the existing dark theme.

**Tech Stack:** Node.js/Fastify (backend), vanilla JS/HTML/CSS (dashboard), `parseOcrResponse` regex parser

---

### Task 1: Backend — GET `/v1/slides/:id/slide2` endpoint

**Files:**
- Modify: `api/src/routes/slides.js` (after the existing `/label` endpoint around line 382)

**Step 1: Add the slide2 endpoint**

Insert after the existing `GET /slides/:slideId/label` handler (after line 382):

```javascript
  // Get slide2 overview image (from dsmeta directory)
  fastify.get('/slides/:slideId/slide2', async (request, reply) => {
    const { slideId } = request.params;
    const slide = await getSlide(slideId);

    if (!slide || !slide.dsmeta_path) {
      reply.code(404);
      return { error: 'Slide2 not found' };
    }

    const slide2Path = join(slide.dsmeta_path, 'slide2.jpg');

    try {
      await access(slide2Path);
      reply.header('Content-Type', 'image/jpeg');
      reply.header('Cache-Control', 'no-cache');
      return createReadStream(slide2Path);
    } catch {
      reply.code(404);
      return { error: 'Slide2 image not found' };
    }
  });
```

**Step 2: Verify by building**

Run: `cd /home/ivanpires/Business/supernavi/supernavi_edge && docker compose build api`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add api/src/routes/slides.js
git commit -m "feat(api): add GET /slides/:id/slide2 endpoint

Serves the slide2.jpg overview image from the .dsmeta directory,
used by the OCR review modal to show the full slide view.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 2: Backend — POST `/v1/slides/:id/rename` endpoint

**Files:**
- Modify: `api/src/routes/slides.js` (after the `/reocr` endpoint, around line 467)
- Modify: `api/src/lib/label-ocr.js` (import `parseOcrResponse` — already exported)

**Step 1: Add the rename endpoint**

Insert after the existing `POST /slides/:slideId/reocr` handler (after line 467):

```javascript
  // Manual rename: technician manually sets the slide name
  fastify.post('/slides/:slideId/rename', async (request, reply) => {
    const { slideId } = request.params;
    const { name } = request.body || {};

    if (!name || typeof name !== 'string') {
      reply.code(400);
      return { error: 'Missing or invalid "name" field' };
    }

    const slide = await getSlide(slideId);
    if (!slide) {
      reply.code(404);
      return { error: 'Slide not found' };
    }

    // Validate using the same parser as OCR
    const { parseOcrResponse } = await import('../lib/label-ocr.js');
    const parsed = parseOcrResponse(name.trim());

    if (!parsed) {
      reply.code(400);
      return { error: 'Invalid format. Expected: AP26000388A1, C26000588A, 26_388A, etc.' };
    }

    const format = slide.format || 'svs';
    const newFilename = parsed.fullName + '.' + format;

    // Update slide DB
    await updateSlideOcr(slideId, {
      originalFilename: newFilename,
      externalCaseId: `pathoweb:${parsed.caseBase}`,
      externalCaseBase: parsed.caseBase,
      externalSlideLabel: parsed.fullName,
      ocrStatus: 'done',
    });

    // Re-emit SlideRegistered outbox event if tilegen is done
    const slideRow = await query(
      'SELECT width, height, mpp, tilegen_status, external_case_id, external_case_base, external_slide_label FROM slides WHERE id = $1',
      [slideId]
    );
    const s = slideRow.rows[0];
    if (s && s.tilegen_status === 'done') {
      await query(
        `INSERT INTO outbox_events (entity_type, entity_id, op, payload)
         VALUES ($1, $2, $3, $4)`,
        ['slide', slideId, 'registered', JSON.stringify({
          slide_id: slideId,
          case_id: null,
          svs_filename: newFilename,
          width: s.width || 0,
          height: s.height || 0,
          mpp: parseFloat(s.mpp) || 0,
          external_case_id: s.external_case_id,
          external_case_base: s.external_case_base,
          external_slide_label: s.external_slide_label,
        })]
      );
    }

    return {
      success: true,
      ocrStatus: 'done',
      fullName: parsed.fullName,
      caseBase: parsed.caseBase,
      slideLabel: parsed.slideLabel,
      newFilename,
    };
  });
```

Note: `parseOcrResponse` is already imported at the top of slides.js via `import { ocrLabel, isOcrEnabled } from '../lib/label-ocr.js'`. You need to add `parseOcrResponse` to that import. Change line 9:

```javascript
import { ocrLabel, isOcrEnabled } from '../lib/label-ocr.js';
```

to:

```javascript
import { ocrLabel, isOcrEnabled, parseOcrResponse } from '../lib/label-ocr.js';
```

Then use `parseOcrResponse` directly instead of dynamic import:

```javascript
    const parsed = parseOcrResponse(name.trim());
```

**Step 2: Verify by building**

Run: `cd /home/ivanpires/Business/supernavi/supernavi_edge && docker compose build api`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add api/src/routes/slides.js
git commit -m "feat(api): add POST /slides/:id/rename for manual OCR correction

Allows technicians to manually set the slide name with the same
validation as the OCR parser. Updates DB and re-emits outbox event.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 3: HTML — Expand the OCR modal structure

**Files:**
- Modify: `api/src/dashboard/index.html` (lines 289-322, the OCR modal)

**Step 1: Replace the OCR modal HTML**

Replace the entire OCR modal block (lines 289-322) with:

```html
  <!-- OCR Review Modal -->
  <div class="ocr-modal-overlay" id="ocrModal">
    <div class="ocr-modal">
      <div class="ocr-modal-header">
        <h2 class="ocr-modal-title">Verifica&ccedil;&atilde;o OCR</h2>
        <button class="ocr-modal-close" id="ocrModalClose" aria-label="Fechar">&times;</button>
      </div>
      <div class="ocr-modal-body">
        <!-- Image tabs -->
        <div class="ocr-tabs">
          <button class="ocr-tab active" data-tab="slide2">L&acirc;mina</button>
          <button class="ocr-tab" data-tab="label">Label</button>
        </div>
        <div class="ocr-label-container">
          <img class="ocr-label-image" id="ocrSlide2Image" alt="Vis&atilde;o geral da l&acirc;mina">
          <img class="ocr-label-image" id="ocrLabelImage" alt="Label da l&acirc;mina" style="display:none">
          <div class="ocr-label-placeholder" id="ocrLabelPlaceholder" style="display:none">Imagem n&atilde;o dispon&iacute;vel</div>
        </div>
        <!-- Info rows -->
        <div class="ocr-info">
          <div class="ocr-info-row">
            <span class="ocr-info-label">Leitura OCR</span>
            <span class="ocr-info-value" id="ocrReading">--</span>
          </div>
          <div class="ocr-info-row">
            <span class="ocr-info-label">Arquivo</span>
            <span class="ocr-info-value ocr-filename-value" id="ocrFilename">--</span>
          </div>
          <div class="ocr-info-row">
            <span class="ocr-info-label">Status</span>
            <span class="ocr-info-value" id="ocrStatusValue">--</span>
          </div>
        </div>
        <!-- Manual edit -->
        <div class="ocr-manual-edit">
          <label class="ocr-manual-label">Corrigir manualmente:</label>
          <div class="ocr-manual-input-row">
            <input type="text" class="ocr-manual-input" id="ocrManualInput" placeholder="AP26000388A1 ou 26_388A" autocomplete="off" spellcheck="false">
            <button class="btn-manual-save" id="btnManualSave" disabled title="Salvar">&#10003;</button>
          </div>
          <div class="ocr-manual-preview" id="ocrManualPreview"></div>
        </div>
        <div class="ocr-status-msg" id="ocrStatusMsg"></div>
      </div>
      <div class="ocr-modal-footer">
        <button class="btn-reocr" id="btnReocr">Re-ler OCR</button>
        <button class="btn-close-modal" id="btnCloseOcr">Fechar</button>
      </div>
    </div>
  </div>
```

**Step 2: Commit**

```bash
git add api/src/dashboard/index.html
git commit -m "feat(dashboard): add image tabs and manual edit to OCR modal HTML

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 4: CSS — Style image tabs and manual edit form

**Files:**
- Modify: `api/src/dashboard/style.css` (add after the existing OCR modal styles, before the Maintenance Section around line 1431)

**Step 1: Add CSS for tabs and manual edit**

Insert before `/* ===== Maintenance Section ===== */` (line 1432):

```css
/* ===== OCR Image Tabs ===== */
.ocr-tabs {
  display: flex;
  gap: 0;
  margin-bottom: 0;
}

.ocr-tab {
  flex: 1;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-bottom: none;
  color: var(--text-muted);
  font-family: inherit;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 8px 16px;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.ocr-tab:first-child {
  border-radius: var(--radius-sm) 0 0 0;
}

.ocr-tab:last-child {
  border-radius: 0 var(--radius-sm) 0 0;
}

.ocr-tab.active {
  background: var(--bg-base);
  color: var(--text-primary);
  border-color: var(--border);
}

.ocr-tab:not(.active):hover {
  color: var(--text-secondary);
  background: var(--bg-card-hover);
}

/* ===== OCR Manual Edit ===== */
.ocr-manual-edit {
  margin-bottom: 16px;
}

.ocr-manual-label {
  display: block;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
  margin-bottom: 8px;
}

.ocr-manual-input-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.ocr-manual-input {
  flex: 1;
  background: var(--bg-base);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 14px;
  font-weight: 600;
  padding: 8px 12px;
  letter-spacing: 0.02em;
  outline: none;
  transition: border-color var(--transition-fast);
}

.ocr-manual-input:focus {
  border-color: var(--accent);
}

.ocr-manual-input.input-valid {
  border-color: var(--green);
}

.ocr-manual-input.input-invalid {
  border-color: var(--red);
}

.btn-manual-save {
  background: var(--green-bg);
  color: var(--green);
  border: 1px solid rgba(34, 197, 94, 0.15);
  font-size: 16px;
  font-weight: 700;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--transition-fast);
}

.btn-manual-save:hover:not(:disabled) {
  background: var(--green);
  color: #fff;
  box-shadow: 0 2px 8px rgba(34, 197, 94, 0.3);
}

.btn-manual-save:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.ocr-manual-preview {
  font-size: 11px;
  font-family: var(--font-mono);
  margin-top: 6px;
  min-height: 16px;
  letter-spacing: 0.02em;
}

.ocr-manual-preview.preview-valid {
  color: var(--green);
}

.ocr-manual-preview.preview-invalid {
  color: var(--red);
}
```

**Step 2: Remove the border-radius from `.ocr-label-container` top corners**

The tabs sit directly above the image container, so they need to flow together. Change the existing `.ocr-label-container` rule (line 1271) — add `border-radius: 0 0 var(--radius) var(--radius);` to replace the current `border-radius: var(--radius);`:

Find:
```css
.ocr-label-container {
  background: var(--bg-base);
  border: 1px solid var(--border);
  border-radius: var(--radius);
```

Replace with:
```css
.ocr-label-container {
  background: var(--bg-base);
  border: 1px solid var(--border);
  border-radius: 0 0 var(--radius) var(--radius);
```

**Step 3: Commit**

```bash
git add api/src/dashboard/style.css
git commit -m "feat(dashboard): style OCR image tabs and manual edit form

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 5: JavaScript — Image tabs, manual edit, and parse validation

**Files:**
- Modify: `api/src/dashboard/app.js` (the OCR modal section, lines 388-525)

**Step 1: Add `parseOcrInput` function**

Add this function right before the `initOcrModal()` function (before line 393). This is a client-side copy of the backend parse logic for real-time validation:

```javascript
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
```

**Step 2: Update `initOcrModal()` to wire up tabs and manual edit**

Replace the existing `initOcrModal()` function (lines 393-415) with:

```javascript
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
```

**Step 3: Add `switchOcrImage()` function**

Add after `initOcrModal()`:

```javascript
  function switchOcrImage(tab) {
    const slide2Img = $('#ocrSlide2Image');
    const labelImg = $('#ocrLabelImage');
    const placeholder = $('#ocrLabelPlaceholder');

    if (tab === 'slide2') {
      if (slide2Img) slide2Img.style.display = '';
      if (labelImg) labelImg.style.display = 'none';
      if (placeholder) placeholder.style.display = 'none';
      // Show placeholder if slide2 failed to load
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
```

**Step 4: Update `openOcrModal()` to load both images and pre-fill manual input**

Replace the existing `openOcrModal()` function (lines 417-462) with:

```javascript
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
```

**Step 5: Add `triggerManualSave()` function**

Add after the existing `triggerReocr()` function:

```javascript
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
```

**Step 6: Update `triggerReocr()` to also update the manual input after re-OCR**

In the existing `triggerReocr()` function, inside the `if (data.success)` block (around where it calls `setText('#ocrReading', ...)`), add these lines after `fetchSlides()`:

```javascript
        // Update manual input with new reading
        const manualInput = $('#ocrManualInput');
        if (manualInput) {
          manualInput.value = data.fullName || '';
          manualInput.dispatchEvent(new Event('input'));
        }
```

**Step 7: Commit**

```bash
git add api/src/dashboard/app.js
git commit -m "feat(dashboard): add image tabs, manual edit, and live validation to OCR modal

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 6: Build and verify

**Step 1: Run parse tests**

Run: `cd /home/ivanpires/Business/supernavi/supernavi_edge/api && node --test src/lib/label-ocr.test.js`
Expected: All 15 tests PASS

**Step 2: Build Docker containers**

Run: `cd /home/ivanpires/Business/supernavi/supernavi_edge && docker compose build api`
Expected: Build succeeds

**Step 3: Commit (if any fixups needed)**

If fixes were needed, commit with appropriate message.
