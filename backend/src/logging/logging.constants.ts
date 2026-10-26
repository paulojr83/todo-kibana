export const DEFAULT_ELASTICSEARCH_NODE = 'http://localhost:9200';

// Data streams no padrão logs-<dataset>-<namespace>: o ES 8 aplica o index
// template "logs" embutido (mapeamento ECS + ILM) sem nenhuma configuração extra.
export const BACKEND_LOGS_INDEX = 'logs-todo.backend-default';
export const FRONTEND_LOGS_INDEX = 'logs-todo.frontend-default';

export const REQUEST_ID_HEADER = 'x-request-id';
export const SESSION_ID_HEADER = 'x-session-id';
