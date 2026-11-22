/**
 * Spanish locale (stub).
 *
 * This file demonstrates that adding a second language is cheap: copy the
 * English catalogue, translate the values, done.  Strings that have not yet
 * been translated fall back to English automatically via the t() function.
 */
import type { Catalogue } from './en.js';

export const es: Partial<Catalogue> = {
  tagline: 'Mira lo que tus contratos Soroban están emitiendo.',
  switchToLight: 'Cambiar a tema claro',
  switchToDark: 'Cambiar a tema oscuro',
  lightMode: 'Modo claro',
  darkMode: 'Modo oscuro',

  language: 'Idioma',

  eventCount: '{count} evento{suffix}',
  eventCountForContract: '{count} evento{suffix} para este contrato',
  eventCountWithTopic: '{count} evento{suffix} con el tema \u201c{topic}\u201d',
  eventCountForContractWithTopic:
    '{count} evento{suffix} para este contrato con el tema \u201c{topic}\u201d',
  eventCountEstimate: 'aproximadamente {count} evento{suffix}',
  eventCountForContractEstimate: 'aproximadamente {count} evento{suffix} para este contrato',
  eventCountWithTopicEstimate: 'aproximadamente {count} evento{suffix} con el tema \u201c{topic}\u201d',
  eventCountForContractWithTopicEstimate:
    'aproximadamente {count} evento{suffix} para este contrato con el tema \u201c{topic}\u201d',
  eventCountEstimateTitle:
    'Total estimado \u2014 la API sirvi\u00f3 este recuento desde una cach\u00e9 de corta duraci\u00f3n en lugar de contar cada fila, as\u00ed que puede ir unos segundos por detr\u00e1s.',
  live: 'en vivo',
  streamingLive: 'Recibiendo actualizaciones en tiempo real',
  pollingFallback: 'Actualizando cada 5 segundos',
  absoluteTime: 'Hora absoluta',
  relativeTime: 'Hora relativa',
  showAbsoluteTimes: 'Mostrar marcas de tiempo absolutas',
  showRelativeTimes: 'Mostrar marcas de tiempo relativas',

  exportJson: 'Exportar JSON',
  exportCsv: 'Exportar CSV',
  exportJsonTitle: 'Exportar los eventos actuales como JSON',
  exportCsvTitle: 'Exportar los eventos actuales como CSV',

  invalidContractId:
    'Eso no parece un ID de contrato. Se espera un StrKey: C seguido de 55 letras may\u00fasculas y d\u00edgitos del 2 al 7.',

  loading: 'Cargando\u2026',
  emptyContractUnknown:
    'Este contrato no ha sido visto por este indexador. Verifica el ID y que sea uno que esta instancia indexa (LENS_CONTRACT_IDS).',
  emptyNoMatchingEvents:
    'Este contrato est\u00e1 indexado, pero ning\u00fan evento coincide con estos filtros.',
  emptyNothingIndexed:
    'Nada indexado a\u00fan, y el indexador nunca se ha ejecutado contra esta base de datos. In\u00edcialo con `lens index` (o `docker compose up`), o carga los datos de ejemplo con `npm run seed`.',
  emptyIndexerCatchingUp:
    'El indexador est\u00e1 en marcha (\u00faltimo ledger {ledger}) pero a\u00fan no ha guardado ning\u00fan evento. Puede que siga recorriendo el historial o que los contratos vigilados est\u00e9n inactivos; los eventos aparecer\u00e1n aqu\u00ed a medida que se indexen.',
  emptyApiUnreachable:
    'No se puede conectar con la API, as\u00ed que no hay nada que mostrar. Comprueba que est\u00e1 en marcha (`npm run api` o `docker compose ps`) y que la URL de esta red es correcta.',
  emptyRequestFailed: 'La petici\u00f3n de eventos fall\u00f3 (ver el mensaje de arriba), as\u00ed que estos resultados no son una respuesta real. Corrige la petici\u00f3n o reint\u00e9ntalo cuando la API se recupere.',
  emptyNoResults: 'Ning\u00fan evento coincide con estos filtros. Quita o relaja un filtro para ver m\u00e1s.',

  loadMore: 'Cargar {count} m\u00e1s',
  loadingMore: 'Cargando\u2026',

  footerTagline: 'Soroban Lens \u2014 una lente de lectura para los eventos de contratos Soroban.',
  sourceLink: 'C\u00f3digo fuente',

  networkLabel: 'Red',
  connected: 'conectado',
  degraded: 'degradado',
  connecting: 'conectando\u2026',
  healthStats: '{count} eventos \u00b7 {contracts} contratos',
  lastUpdated: 'actualizado {time}',
  networkMismatch:
    'Esta API reporta la red {reported}, pero aqu\u00ed est\u00e1 configurada como {selected}. Verifica VITE_LENS_NETWORKS y LENS_NETWORK del indexador.',

  contractIdLabel: 'ID de contrato',
  contractIdPlaceholder: 'C\u2026 (deja vac\u00edo para ver todos los contratos indexados)',
  useTestnetExample: 'usar el contrato XLM de testnet',
  topicLabel: 'Tema',
  topicPlaceholder: 'transfer',
  successfulOnly: 'Solo llamadas exitosas',
  liveUpdates: 'Actualizaciones en vivo',

  expandDetails: 'Expandir detalles del evento',
  collapseDetails: 'Contraer detalles del evento',
  colExpand: 'Expandir',
  colLedger: 'Ledger',
  colContract: 'Contrato',
  colTopic: 'Tema',
  colValue: 'Valor',
  colTx: 'Tx',

  filterByTopic: 'Filtrar por \u201c{topic}\u201d',
  additionalTopics: '+{count}',
  failedCallWarning:
    'Emitido durante una llamada al contrato que no tuvo \u00e9xito. Est\u00e1 indexado por completitud, pero no tuvo efecto en la cadena.',
  decodeError: 'Error de decodificaci\u00f3n: {message}',
  detailEventId: 'ID de evento',
  detailContract: 'Contrato',
  detailLedger: 'Ledger',
  detailClosedAt: 'Cerrado en',
  detailTransaction: 'Transacci\u00f3n',
  detailPosition: 'Posici\u00f3n',
  detailPositionValue: 'tx {txIndex} / op {opIndex}',
  typedSourceBuiltIn: 'decodificado con la especificaci\u00f3n integrada de Stellar Asset Contract',
  typedSourceOwn: 'decodificado con la especificaci\u00f3n del propio contrato',
  topicsHeading: 'Temas',
  valueHeading: 'Valor',
  rawXdr: 'XDR sin procesar',
  rawXdrDesc:
    'Exactamente lo que emiti\u00f3 la red. Los campos decodificados arriba se derivan de estos.',
  rawTopicsHeading: 'Temas',
  rawValueHeading: 'Valor',

  componentError: 'Error de componente',
  defaultErrorMessage: 'Ocurri\u00f3 un error de renderizado inesperado.',
  reloadComponent: 'Recargar componente',
};
