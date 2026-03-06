# OCR slide2.jpg as Primary Source — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Switch OCR primary source from label.jpg (cropped, often cuts handwritten codes) to slide2.jpg (full slide overview with complete code visible at top).

**Architecture:** Change `ocrLabel()` to accept a `.dsmeta` directory path instead of a label.jpg path. Try slide2.jpg first with a new prompt optimized for full-slide images, then fall back to label.jpg + slide2.jpg together.

**Tech Stack:** Node.js, Claude Vision API (claude-sonnet-4-6), node:test

---

### Task 1: Update `ocrLabel()` — new prompt and flow

**Files:**
- Modify: `api/src/lib/label-ocr.js:82-190`

**Step 1: Add the new `SLIDE_OVERVIEW_PROMPT` constant**

After line 96 (end of `LABEL_PROMPT`), add:

```javascript
const SLIDE_OVERVIEW_PROMPT = `This is a photo of an entire pathology slide. The case identifier is usually HANDWRITTEN on the TOP PORTION of the slide (the label area).

Look at the upper part of the image to find the identifier.

The identifier format:
- Starts with AP or PA (Anatomopatológico), C (Citologia), or IM (Imuno-histoquímico), followed by 6-8 digits.
- May have a handwritten suffix: flask letter (A, B, C...) and optional slide number (1, 2, 3...).
- May be ABBREVIATED: "26_388A" means AP26000388A (zeros suppressed with underscore).

Examples:
  Full: AP26000388A1, AP26000388B, PA26000019, C26000588A, IM26000100A2
  Abbreviated: 26_388A, 26_388B2, 26_100A (write exactly as seen, e.g. "26_388A")

Ignore patient names, doctor names, "urgente", or other annotations. Only extract the case identifier.

Reply with ONLY the identifier (e.g., "AP26000388A1" or "26_388A"). No other text.
If you cannot read the identifier, reply with UNREADABLE.`;
```

**Step 2: Rewrite `ocrLabel()` to accept dsmetaDir**

Replace the entire `ocrLabel` function (lines 158-190) with:

```javascript
/**
 * OCR a slide's label from its .dsmeta directory.
 * Strategy:
 *   1. Try slide2.jpg (full slide overview — code visible at top, not cropped)
 *   2. Fallback: label.jpg + slide2.jpg together (cross-reference)
 *   3. Return null if both fail
 *
 * @param {string} dsmetaDir - Path to the .dsmeta directory
 * @returns {Promise<{ fullName: string, caseBase: string, slideLabel: string } | null>}
 */
export async function ocrLabel(dsmetaDir) {
  const slide2Path = join(dsmetaDir, 'slide2.jpg');
  const labelPath = join(dsmetaDir, 'label.jpg');

  // Stage 1: Try slide2.jpg (full slide, code not cropped)
  try {
    await access(slide2Path, constants.R_OK);
    const slide2Image = await readImage(slide2Path);
    const rawText = await callVision([slide2Image], SLIDE_OVERVIEW_PROMPT);
    console.log(`[OCR] slide2.jpg response for ${dsmetaDir}: "${rawText}"`);

    if (rawText.trim().toUpperCase() !== 'UNREADABLE') {
      const result = parseOcrResponse(rawText);
      if (result) return result;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    console.log(`[OCR] No slide2.jpg at ${slide2Path}`);
  }

  // Stage 2: Fallback — label.jpg + slide2.jpg together
  let hasLabel = false;
  let hasSlide2 = false;

  try {
    await access(labelPath, constants.R_OK);
    hasLabel = true;
  } catch {}
  try {
    await access(slide2Path, constants.R_OK);
    hasSlide2 = true;
  } catch {}

  if (hasLabel && hasSlide2) {
    console.log(`[OCR] Retrying with label.jpg + slide2.jpg from ${dsmetaDir}`);
    const labelImage = await readImage(labelPath);
    const slide2Image = await readImage(slide2Path);
    const retryText = await callVision([labelImage, slide2Image], LABEL_WITH_SLIDE_PROMPT);
    console.log(`[OCR] Retry response (label+slide2): "${retryText}"`);

    if (retryText.trim().toUpperCase() !== 'UNREADABLE') {
      return parseOcrResponse(retryText);
    }
  } else if (hasLabel) {
    // No slide2.jpg available, try label alone as last resort
    console.log(`[OCR] Only label.jpg available, trying label alone from ${dsmetaDir}`);
    const labelImage = await readImage(labelPath);
    const rawText = await callVision([labelImage], LABEL_PROMPT);
    console.log(`[OCR] Label-only response: "${rawText}"`);

    if (rawText.trim().toUpperCase() !== 'UNREADABLE') {
      return parseOcrResponse(rawText);
    }
  }

  return null;
}
```

**Step 3: Update the JSDoc header comment at top of file**

Replace lines 1-16 with:

```javascript
/**
 * Label OCR via Claude Vision API.
 *
 * Sends slide images to Claude and extracts the case identifier.
 * Primary source: slide2.jpg (full slide overview, code visible at top).
 * Fallback: label.jpg + slide2.jpg cross-reference.
 *
 * Labels contain:
 *   - Printed text: case number (e.g., AP26000388 or IM26000100)
 *   - Handwritten text: flask/slide suffix (e.g., A1, B, A2)
 *
 * Prefixes:
 *   AP = Anatomopatológico
 *   PA = Patologia Anatômica (alias for AP)
 *   C  = Citologia
 *   IM = Imuno-histoquímico
 *
 * Pattern: [AP|PA|C|IM][6-8 digits][letter][optional digit(s)]
 */
```

**Step 4: Remove unused `dirname` import**

In line 19, change:

```javascript
import { dirname, join } from 'path';
```

to:

```javascript
import { join } from 'path';
```

`dirname` was only used in old `ocrLabel()` to derive dsmetaDir from labelPath — no longer needed.

**Step 5: Run tests to verify parse logic unchanged**

Run: `cd api && node --test src/lib/label-ocr.test.js`
Expected: All 16 tests PASS (parse tests don't touch `ocrLabel()`)

**Step 6: Commit**

```bash
git add api/src/lib/label-ocr.js
git commit -m "feat(ocr): use slide2.jpg as primary OCR source

slide2.jpg shows the full slide with the complete handwritten code
visible at the top, avoiding the cropping issue with label.jpg."
```

---

### Task 2: Update scanner-adapter.js callers

**Files:**
- Modify: `api/src/services/scanner-adapter.js:96-105,222-227`

**Step 1: Update `processNewFile()` — pass dsmetaDir instead of labelPath**

Replace lines 96-105:

```javascript
  const dsmetaDir = filePath + '.dsmeta';
  const labelPath = dsmetaDir + '/label.jpg';

  if (isOcrEnabled()) {
    try {
      await access(labelPath, constants.R_OK);
      dsmetaPath = dsmetaDir;

      console.log(`[Scanner] OCR: found label at ${labelPath}`);
      const ocrResult = await ocrLabel(labelPath);
```

with:

```javascript
  const dsmetaDir = filePath + '.dsmeta';

  if (isOcrEnabled()) {
    try {
      await access(dsmetaDir, constants.R_OK);
      dsmetaPath = dsmetaDir;

      console.log(`[Scanner] OCR: found dsmeta at ${dsmetaDir}`);
      const ocrResult = await ocrLabel(dsmetaDir);
```

Note: We now check if the `.dsmeta` directory exists (not label.jpg specifically), since `ocrLabel()` internally handles which files are available.

**Step 2: Update `retryPendingOcr()` — pass dsmetaDir instead of labelPath**

Replace lines 223-227:

```javascript
      const labelPath = slide.dsmeta_path + '/label.jpg';
      await access(labelPath, constants.R_OK);

      const ocrResult = await ocrLabel(labelPath);
```

with:

```javascript
      await access(slide.dsmeta_path, constants.R_OK);

      const ocrResult = await ocrLabel(slide.dsmeta_path);
```

**Step 3: Commit**

```bash
git add api/src/services/scanner-adapter.js
git commit -m "refactor(ocr): pass dsmetaDir to ocrLabel in scanner adapter"
```

---

### Task 3: Update slides.js `/reocr` endpoint

**Files:**
- Modify: `api/src/routes/slides.js:404-414`

**Step 1: Update `/reocr` handler**

Replace lines 404-414:

```javascript
    const labelPath = join(slide.dsmeta_path, 'label.jpg');

    try {
      await access(labelPath);
    } catch {
      reply.code(404);
      return { error: 'Label image not found at dsmeta path' };
    }

    // Run OCR
    const ocrResult = await ocrLabel(labelPath);
```

with:

```javascript
    try {
      await access(slide.dsmeta_path);
    } catch {
      reply.code(404);
      return { error: 'dsmeta directory not found' };
    }

    // Run OCR
    const ocrResult = await ocrLabel(slide.dsmeta_path);
```

**Step 2: Commit**

```bash
git add api/src/routes/slides.js
git commit -m "refactor(ocr): pass dsmetaDir to ocrLabel in reocr endpoint"
```

---

### Task 4: Build and verify

**Step 1: Run parse tests**

Run: `cd api && node --test src/lib/label-ocr.test.js`
Expected: All 16 tests PASS

**Step 2: Build Docker containers**

Run: `docker compose build api`
Expected: Build succeeds without errors

**Step 3: Commit (final, if any fixups needed)**

If any fixes were needed, commit them with an appropriate message.
