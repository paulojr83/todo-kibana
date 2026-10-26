# 📋 To-do List com Kibana Plugin

A full-stack Todo List application with integrated request tracking and visualization using the Elastic Stack (Elasticsearch and Kibana).

## 🏗️ Architecture

- **Frontend**: React (TypeScript) SPA for managing tasks.
- **Backend**: NestJS (TypeScript) REST API with MongoDB for data storage.
- **Observability**: Integration with Elasticsearch and Kibana for logging and monitoring request performance.
- **Infrastructure**: Containerized environment using Docker Compose.

---

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+ recommended)
- [Docker](https://www.docker.com/) and Docker Compose
- npm or yarn

### Setup

1.  **Clone the repository**:
    ```bash
    git clone <repository-url>
    cd projeto-todo-kibana
    ```

2.  **Environment Variables**:
    Copy the example environment file and adjust values if necessary:
    ```bash
    cp .env.example .env
    # Also copy to subdirectories if needed by your IDE/local runner
    cp .env.example backend/.env
    cp .env.example frontend/.env
    ```

3.  **Infrastructure**:
    Start MongoDB, Elasticsearch, and Kibana:
    ```bash
    docker-compose up -d
    ```

4.  **Backend**:
    ```bash
    cd backend
    npm install
    npm run start:dev
    ```

5.  **Frontend**:
    ```bash
    cd ../frontend
    npm install
    npm run start
    ```

---

## 🛠️ Scripts

### Backend (`/backend`)
- `npm run start`: Start the application.
- `npm run start:dev`: Start in development mode with watch mode.
- `npm run build`: Build the production application.
- `npm run test`: Run unit tests.
- `npm run test:e2e`: Run end-to-end tests.
- `npm run lint`: Run ESLint to check code quality.

### Frontend (`/frontend`)
- `npm run start`: Run the React app in development mode.
- `npm run build`: Build the app for production.
- `npm run test`: Run the test runner.

---

## ⚙️ Environment Variables

The application uses the following variables (defined in `.env`):

| Variable | Description | Default |
| :--- | :--- | :--- |
| `MONGODB_URI` | Connection string for MongoDB | `mongodb://admin:password@localhost:27017/todo-app?authSource=admin` |
| `PORT` | Backend port | `3000` |
| `LOG_LEVEL` | Backend log level (`debug`, `info`, `warn`, `error`) | `info` |
| `ELASTICSEARCH_NODE` | Elasticsearch used by the backend to store logs | `http://localhost:9200` |
| `LOG_TO_ELASTICSEARCH` | Set to `false` to keep logs only on the console | `true` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP endpoint (Tempo) for backend traces | `http://localhost:4318` |
| `OTEL_SDK_DISABLED` | Set to `true` to disable backend tracing | `false` |
| `CORS_ORIGINS` | Comma-separated origins allowed by the backend | `http://localhost:3000,http://localhost:3001,http://localhost:5601` |
| `REACT_APP_API_URL` | Frontend API URL | `http://localhost:3000` |
| `REACT_APP_OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP endpoint (Tempo) for browser traces | `http://localhost:4318` |
| `REACT_APP_OTEL_ENABLED` | Set to `false` to disable frontend tracing | `true` |
| `REACT_APP_GRAFANA_URL` | Grafana used in the dev-only `[Trace]` console links | `http://localhost:3030` |
| `REACT_APP_LOG_LEVEL` | Minimum level the frontend sends to Kibana | `debug` (dev) / `info` (build) |
| `ELASTICSEARCH_HOSTS` | Elasticsearch endpoint | `http://localhost:9200` |
| `BACKEND_URL` | Backend URL for Kibana integration | `http://localhost:3000/api/todos` |

---

## 📊 Logs in Kibana

Backend and frontend logs are stored in Elasticsearch in [ECS](https://www.elastic.co/guide/en/ecs/current/index.html) format:

| Source | Data stream | How it gets there |
| :--- | :--- | :--- |
| Backend | `logs-todo.backend-default` | `nestjs-pino` writes straight to Elasticsearch (every `Logger` call + one line per HTTP request) |
| Frontend | `logs-todo.frontend-default` | `src/logging/logger.ts` batches entries and sends them to `POST /api/logs` |

The frontend captures API calls (axios interceptors), uncaught errors and unhandled promise rejections, plus explicit `createLogger(...)` calls.

`docker-compose up -d` also runs the one-shot `kibana-setup` service, which creates the **Todo - Logs** data view (`logs-todo.*`) and a saved search with the same name. Open <http://localhost:5601/app/discover>.

Useful filters:

- `service.name : "todo-backend"` / `service.name : "todo-frontend"`
- `http.request.id : "<id>"`: one API call on both sides (the frontend sends it as `x-request-id`)
- `labels.session_id : "<id>"`: everything from one browser tab
- `log.level : "error"`

## 📈 Grafana

Grafana runs at <http://localhost:3030>. The frontend already uses port 3000. It reads the same `logs-todo.*` data streams from Elasticsearch, and the **Todo - Logs** dashboard is its home page. You can view it without logging in; to edit, sign in as `admin` / `admin`.

The dashboard has:

- Totals for logs, errors, HTTP requests and 5xx responses
- Log volume per level
- Backend latency (p50/p95)
- Requests per HTTP status
- Most-called routes (grouped by `http.route`, e.g. `/api/todos/:id`)
- A logs panel with filters for service, level and a free Lucene search

In a log's details, `trace.id` links to that trace in Tempo (inside Grafana) and in Kibana APM.

The datasource and dashboard live in `grafana/` and are copied into the image at build time, so this works without Docker Desktop's WSL integration. After editing them, run:

```bash
docker-compose up -d --build grafana
```

## 🔎 Tracing (OpenTelemetry)

Both sides are instrumented with OpenTelemetry and send traces over OTLP straight to **Tempo** (`localhost:4318`). Tempo's OTLP receiver allows CORS for the frontend origins. Kibana APM no longer receives this project's traces; use Grafana for them.

- **Frontend** (`src/logging/tracing.ts`): records page-load timings. The axios interceptors in `src/services/todoApi.ts` create one span per API call and send its `traceparent` header.
- **Backend** (`src/tracing.ts`, loaded before anything else in `main.ts`): continues that trace, with spans for the HTTP request, the Nest controller and each MongoDB query. The pino instrumentation adds `trace.id` to every log.

A single trace therefore covers browser → API → MongoDB.

| Where | How |
| :--- | :--- |
| Grafana | **Explore → Tempo** (search by trace ID or TraceQL, Service Graph tab) or **Drilldown → Traces**. Each span links to its logs. |

In development (`npm start`), every API call also prints a line to the browser console. It shows `[Trace] <trace id>`, a link that opens that trace in Grafana (Explore → Tempo) and the request URL. Production builds print nothing.

Log shipping to Elasticsearch, `/api/logs` and CORS preflights are excluded from tracing on purpose.

### Kubernetes

The instrumentation is plain OpenTelemetry, so moving to Kubernetes needs no code changes:

- run Alloy (for example through the `grafana/k8s-monitoring` Helm chart) and Tempo (`grafana/tempo`);
- point `OTEL_EXPORTER_OTLP_ENDPOINT` at the Alloy service;
- alternatively, let the OpenTelemetry Operator inject the Node.js SDK through the `instrumentation.opentelemetry.io/inject-nodejs` annotation.

---

## 📁 Project Structure

```text
.
├── backend/            # NestJS Application
│   ├── src/            # Source code
│   └── test/           # Tests
├── frontend/           # React Application
│   ├── src/            # Source code
│   └── public/         # Static assets
├── grafana/            # Grafana image: datasources (ES, Tempo, Prometheus) + dashboard
├── tempo/              # Tempo image: trace storage + metrics generator
├── docker-compose.yml  # Infrastructure (Mongo, ES, Kibana, APM Server, Tempo, Prometheus, Grafana)
└── .env.example        # Template for environment variables
```

---

## 🧪 Testing

- **Backend**: Run `npm run test` inside the `backend` folder.
- **Frontend**: Run `npm run test` inside the `frontend` folder.
- **TODO**: Add integration tests for Kibana plugin/Elasticsearch connection.

---

## 📝 License

This project is licensed under the MIT License - see the [backend/package.json](backend/package.json) file for details.
