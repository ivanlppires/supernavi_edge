/**
 * Failure advisor — maps raw error messages from the pipeline to user-friendly
 * diagnoses and suggested actions, displayed in the dashboard's "Falhas" tab.
 *
 * advise(stage, message) -> { reason, suggestion, severity, action }
 *   severity: 'critical' | 'warning' | 'info'
 *   action:   'reprocess' | 'redigitalize' | 'check_disk' | 'check_credentials' |
 *             'check_cloud' | 'wait_retry' | 'check_logs' | 'manual'
 */

const RULES = [
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

  // ── BigTIFF specific ────────────────────────────────────────────────────
  {
    match: /bigtiff.*(failed|error)/i,
    stage: 'bigtiff',
    severity: 'warning',
    action: 'reprocess',
    reason: 'Geração do BigTIFF piramidal falhou.',
    suggestion: 'Re-processe. Verifique espaço em /data/tmp e logs do processor.',
  },

  // ── Cloud upload (Wasabi S3) ────────────────────────────────────────────
  {
    match: /403|forbidden|signature.*does not match|invalid.*credential/i,
    stage: '*',
    severity: 'critical',
    action: 'check_credentials',
    reason: 'Credenciais Wasabi (S3) inválidas ou sem permissão.',
    suggestion: 'Verifique S3_ACCESS_KEY/S3_SECRET_KEY no .env. Confirme que a chave tem acesso ao bucket configurado.',
  },
  {
    match: /404.*(bucket|nosuchbucket)/i,
    stage: '*',
    severity: 'critical',
    action: 'check_credentials',
    reason: 'Bucket S3/Wasabi não encontrado.',
    suggestion: 'Verifique S3_BUCKET no .env e que o bucket existe na região configurada.',
  },
  {
    match: /econnrefused|enotfound|getaddrinfo|network.*(error|unreachable)/i,
    stage: '*',
    severity: 'warning',
    action: 'check_cloud',
    reason: 'Não foi possível alcançar o cloud / S3 endpoint.',
    suggestion: 'Verifique a conexão de internet e o status do tunnel. O sync tentará novamente automaticamente.',
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
  {
    match: /unauthor|401/i,
    stage: 'sync',
    severity: 'critical',
    action: 'check_credentials',
    reason: 'Token de sincronização inválido ou expirado.',
    suggestion: 'Verifique SYNC_TOKEN/EDGE_KEY no .env e a chave no painel admin do cloud.',
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
