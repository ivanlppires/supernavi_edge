/**
 * Preview Module - Remote Preview Publishing
 *
 * Exports the main preview publishing functionality for use by pipelines.
 *
 * The preview system uses a "rebased" approach:
 * - Original image is scaled so max(width,height) = PREVIEW_TARGET_MAX_DIM
 * - This scaled image has its own tile pyramid with levels 0..PREVIEW_MAX_LEVEL
 * - OpenSeadragon renders a meaningful preview with proper zoom
 *
 * IMPORTANT: Tiles are uploaded to standard DZI path: {prefix}/{slideId}/tiles/{z}/{x}_{y}.jpg
 */

export { publishRemotePreview, isPreviewEnabled, shutdown } from './publisher.js';
export {
  generateRebasedPreviewTiles,
  calculateRebasedDimensions,
  countRebasedTiles,
  getRebasedConfig
} from './rebasedPreview.js';
export {
  uploadFile,
  uploadJson,
  uploadThumb,
  uploadManifest,
  uploadTile,
  uploadTilesForLevels,
  uploadRebasedTiles,
  createRemoteManifest,
  getSlidePrefix,
  getConfig,
  hashFile,
  hashContent
} from './wasabiUploader.js';
export {
  verifyLocalTiles,
  verifyRemoteTiles,
  verifySampleTilesHEAD,
  compareLocalRemote,
  runFullIntegrityCheck,
  calculateExpectedTiles
} from './integrityCheck.js';
