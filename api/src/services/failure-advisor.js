/**
 * Failure advisor — maps raw error messages from the pipeline to user-friendly
 * diagnoses and suggested actions, displayed in the dashboard's "Falhas" tab.
 *
 * advise(stage, message) -> { reason, suggestion, severity, action }
 *   severity: 'critical' | 'warning' | 'info'
 *   action:   'reprocess' | 'redigitalize' | 'check_disk' | 'check_credentials' |
 *             'check_cloud' | 'wait_retry' | 'check_logs' | 'manual'
 */

// Rules are evaluated in order — first match wins. Specific rules MUST come
// before generic stage-level catch-alls (e.g. "PUT part 6: 403" must hit the
// 403 rule, not the generic "bigtiff failed" rule).
const RULES = [
  // ── HTTP errors (highest priority — they tell us *exactly* what went wrong)
  {
    match: /request.*has expired|expired (signature|url|token)|signature.*expired/i,
    stage: '*',
    severity: 'warning',
    action: 'reprocess',
    reason: 'URL pré-assinada expirou durante o upload.',
    suggestion: 'Upload demorado fez a URL expirar. Re-processe — uploader busca novas URLs em cada tentativa.',
  },
  {
    match: /signature.*does not match|signaturedoesnotmatch|invalid.*signature/i,
    stage: '*',
    severity: 'critical',
    action: 'check_credentials',
    reason: 'Assinatura S3 inválida (provavelmente clock skew ou credencial errada no cloud).',
    suggestion: 'Verifique sincronização de relógio (NTP) no edge e no cloud. Confirme S3_ACCESS_KEY/S3_SECRET_KEY no cloud.',
  },
  {
    match: /\b403\b|forbidden|access denied|invalid.*credential/i,
    stage: '*',
    severity: 'critical',
    action: 'check_credentials',
    reason: 'Cloud/S3 retornou 403 (sem permissão).',
    suggestion: 'Verifique credenciais Wasabi no cloud, política do bucket, e EDGE_KEY no .env do edge. Pode também ser URL pré-assinada expirada — tente re-processar.',
  },
  {
    match: /\b401\b|unauthor/i,
    stage: '*',
    severity: 'critical',
    action: 'check_credentials',
    reason: 'Cloud retornou 401 (não autenticado).',
    suggestion: 'EDGE_KEY pode estar inválido ou expirado. Verifique no painel admin do cloud e atualize o .env do edge.',
  },
  {
    match: /404.*(bucket|nosuchbucket)|nosuchbucket/i,
    stage: '*',
    severity: 'critical',
    action: 'check_credentials',
    reason: 'Bucket S3/Wasabi não encontrado.',
    suggestion: 'Verifique S3_BUCKET no cloud e que o bucket existe na região configurada.',
  },
  {
    match: /econnrefused|enotfound|getaddrinfo|network.*(error|unreachable)|connect.*timeout/i,
    stage: '*',
    severity: 'warning',
    action: 'check_cloud',
    reason: 'Não foi possível alcançar o cloud / S3 endpoint.',
    suggestion: 'Verifique a conexão de internet e o status do tunnel. O sync tentará novamente automaticamente.',
  },
  {
    // undici (Node's fetch) surfaces low-level socket errors as generic
    // "TypeError: fetch failed" — usually a transient TCP reset or DNS hiccup
    // during S3 multipart upload. Must come before the bigtiff catch-all.
    match: /fetch failed|undici|socket hang up|other side closed|econnreset/i,
    stage: '*',
    severity: 'warning',
    action: 'reprocess',
    reason: 'Erro de rede transitório durante upload (fetch/undici falhou).',
    suggestion: 'Conexão caiu durante upload para o S3. Re-processe — costuma resolver. Se persistir, verifique tunnel e estabilidade da internet.',
  },
  {
    match: /\b5\d\d\b|internal server error|service unavailable|bad gateway/i,
    stage: '*',
    severity: 'warning',
    action: 'wait_retry',
    reason: 'Cloud/S3 retornou erro interno (5xx).',
    suggestion: 'Erro temporário do servidor. Re-processe ou aguarde alguns minutos.',
  },

  // ── Disk / filesystem ────────────────────────────────────────────────────
  {
    match: /ENOSPC|no space left|insufficient disk space/i,
    stage: '*',
    severity: 'critical',
    action: 'check_disk',
    reason: 'Disco cheio ou sem espaço suficiente para gerar tiles/BigTIFF.',
    suggestion: 'Libere espaço no disco do edge (mínimo 5 GB livres) e clique em Re-processar.',
  },
  {
    match: /raw file not found|raw file no longer exists|ENOENT/i,
    stage: '*',
    severity: 'critical',
    action: 'redigitalize',
    reason: 'Arquivo bruto (.svs/.tiff) foi removido ou movido após a importação.',
    suggestion: 'Redigitalize a lâmina ou recupere o arquivo original e reimporte.',
  },
  {
    match: /size mismatch|verification failed/i,
    stage: 'ingest',
    severity: 'critical',
    action: 'redigitalize',
    reason: 'A cópia do arquivo bruto ficou corrompida ou foi interrompida.',
    suggestion: 'Apague a lâmina e copie o arquivo original novamente para a pasta de inbox.',
  },

  // ── OpenSlide / vips ────────────────────────────────────────────────────
  {
    match: /openslide.*can'?t open|not a (valid )?(svs|aperio|tiff)|unsupported (file|format)/i,
    stage: '*',
    severity: 'critical',
    action: 'redigitalize',
    reason: 'Arquivo bruto está corrompido ou em formato não suportado.',
    suggestion: 'Redigitalize a lâmina. Confirme que o scanner está exportando SVS/NDPI/TIFF válido.',
  },
  {
    match: /vips.*(error|failed)|dzsave/i,
    stage: 'tilegen',
    severity: 'warning',
    action: 'reprocess',
    reason: 'A geração de tiles via vips dzsave falhou.',
    suggestion: 'Clique em Re-processar. Se persistir, verifique espaço em disco e a integridade do arquivo bruto.',
  },
  {
    match: /timeout/i,
    stage: '*',
    severity: 'warning',
    action: 'reprocess',
    reason: 'A etapa demorou mais do que o limite configurado.',
    suggestion: 'Re-processe. Se ocorrer repetidamente, aumente BIGTIFF_TIMEOUT_MS ou TILEGEN_TIMEOUT_MS.',
  },

  // ── BigTIFF specific (catch-all — must come AFTER http error rules) ─────
  {
    match: /put part \d+/i,
    stage: '*',
    severity: 'warning',
    action: 'reprocess',
    reason: 'Falha durante upload multipart do BigTIFF (parte específica).',
    suggestion: 'Re-processe. Se persistir em partes diferentes, indica URL pré-assinada expirando ou clock skew.',
  },
  {
    match: /bigtiff.*(failed|error)/i,
    stage: 'bigtiff',
    severity: 'warning',
    action: 'reprocess',
    reason: 'Geração do BigTIFF piramidal falhou.',
    suggestion: 'Re-processe. Verifique espaço em /data/tmp e logs do processor.',
  },
  {
    match: /cloud upload (failed|error)/i,
    stage: 'cloud_upload',
    severity: 'warning',
    action: 'reprocess',
    reason: 'Upload das tiles/BigTIFF para a nuvem falhou.',
    suggestion: 'Clique em Re-processar para repetir o upload sem regenerar tiles.',
  },

  // ── Sync rejection from cloud ───────────────────────────────────────────
  {
    match: /schema|invalid payload|invalid event|missing field/i,
    stage: 'sync',
    severity: 'critical',
    action: 'check_logs',
    reason: 'Cloud rejeitou o evento de sincronização por schema inválido.',
    suggestion: 'Versão do edge possivelmente desatualizada em relação ao cloud. Atualize o edge ou verifique logs do mock-cloud.',
  },
  {
    match: /duplicate/i,
    stage: 'sync',
    severity: 'info',
    action: 'manual',
    reason: 'Cloud já tinha registrado este evento (duplicado).',
    suggestion: 'Nenhuma ação necessária — o registro foi marcado como sincronizado.',
  },
  // ── Watcher / ingest ────────────────────────────────────────────────────
  {
    match: /empty file|size 0/i,
    stage: 'ingest',
    severity: 'warning',
    action: 'redigitalize',
    reason: 'Arquivo vazio na pasta de inbox.',
    suggestion: 'Verifique se o scanner concluiu a exportação antes de mover para o inbox.',
  },
];

/**
 * Map a (stage, errorMessage) tuple to a diagnosis.
 */
export function advise(stage, message) {
  const msg = (message || '').toLowerCase();

  for (const rule of RULES) {
    if (rule.stage !== '*' && rule.stage !== stage) continue;
    if (rule.match.test(msg)) {
      return {
        reason: rule.reason,
        suggestion: rule.suggestion,
        severity: rule.severity,
        action: rule.action,
      };
    }
  }

  // Default: unknown error
  return {
    reason: 'Erro não classificado.',
    suggestion: 'Verifique os logs detalhados desta lâmina. Re-processar pode resolver erros transitórios.',
    severity: 'warning',
    action: 'check_logs',
  };
}
