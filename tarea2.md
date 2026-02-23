# Tarea 2: 
# Desarrollo Front-end / Back-end con Integración DevSecOps

**Repositorio base:** [sancano22/Practica2](https://github.com/sancano22/practica2)  
**Fork de trabajo:** [W-Varg/Practica2](https://github.com/W-Varg/Practica2)  
**Estudiante:** Wilver Vargas   



## 1. Análisis del Repositorio Base

### 1.1 Clonar el repositorio

```bash
git clone https://github.com/sancano22/Practica2.git
cd Practica2
```

### 1.2 Arquitectura del sistema

El repositorio implementa una arquitectura de microservicios con los siguientes componentes:

```
[ Frontend (React + Vite) ]
         |
         | Login / JWT
         v
[ users-service  :3001 ]   ← Autenticación, emisión de JWT
         |
         | JWT (validación)
         v
[ api-gateway    :3000 ]   ← Enruta peticiones autenticadas
         |
         v
[ academic-service :3002 ] ← Cursos y datos académicos
```

| Componente        | Tecnología          | Puerto | Responsabilidad                    |
|-------------------|---------------------|--------|------------------------------------|
| `frontend`        | React + Vite        | 5173   | SPA con login y listado de cursos  |
| `users-service`   | Node.js + Express   | 3001   | Autenticación JWT                  |
| `academic-service`| Node.js + Express   | 3002   | CRUD de cursos                     |
| `api-gateway`     | Node.js + Express   | 3000   | Proxy y validación de JWT          |

Todos los servicios corren como contenedores Docker, orquestados con Docker Compose para desarrollo y con Kubernetes (`k8s/`) para producción.

### 1.3 Verificación de funcionalidad previa al pipeline

```bash
# Levantar entorno local
cd backend
docker-compose down
docker-compose up --build

# Verificar health de cada servicio
curl http://localhost:3000/health          # api-gateway
curl http://localhost:3001/health          # users-service
curl http://localhost:3002/health          # academic-service

# Frontend disponible en
open http://localhost:5173
```

Todos los servicios exponen un endpoint `/health` que responde con `status: OK`, confirmando que la aplicación es funcional antes de integrar el pipeline.

---

## 2. Pipeline CI/CD Implementado

El pipeline se encuentra en **`.github/workflows/devsecops.yml`** y se ejecuta en cada `push` o `pull_request` a la rama `main`.

### 2.1 Flujo del pipeline

```
Push / Pull Request
        ↓
[1] Checkout del código
        ↓
[2] Setup Node.js 20
        ↓
[3] Preparar archivos .env (CI)
        ↓
[4] Install & Test – users-service     (npm ci + npm test)
[4] Install & Test – academic-service  (npm ci + npm test)
[4] Install & Test – api-gateway       (npm ci + npm test)
[4] Install & Test – frontend          (npm ci + npm test)
        ↓
[5] SAST con Semgrep (users, academic, api-gateway)
        ↓
[6] Build Docker images (docker compose build)
        ↓
[7] SCA – Trivy scan (users-service, academic-service, api-gateway)
        ↓
[8] Smoke test (docker-compose up + curl /health)
        ↓
[9] Shutdown services
```

### 2.2 Etapas detalladas

#### a) Instalación reproducible

```yaml
- name: Install & Test users-service
  run: |
    cd backend/users-service
    npm ci        # instalación determinista desde package-lock.json
    npm test
```

- Se usa `npm ci` en lugar de `npm install` para garantizar instalaciones reproducibles y detectar inconsistencias en el `package-lock.json`.
- **Gate:** el pipeline falla si `npm ci` no puede resolver las dependencias exactas.

#### b) Análisis de calidad de código

El proyecto usa **ESLint** configurado en `frontend/eslint.config.js`.

```yaml
- name: ESLint – frontend
  run: |
    cd frontend
    npm run lint
```

ESLint detecta errores comunes (variables no usadas, imports incorrectos, malas prácticas de React/hooks). Tiene su **propio step** separado del de testing para que el log de calidad sea independiente y quede como gate explícito.

#### c) Testing automático

Cada servicio tiene su suite de pruebas en el directorio `__tests__/`:

| Servicio           | Framework   | Archivo de test              |
|--------------------|-------------|------------------------------|
| `users-service`    | Jest        | `__tests___/health.test.js`  |
| `academic-service` | Jest        | `__tests__/health.test.js`   |
| `api-gateway`      | Jest        | `__tests__/health.test.js`   |
| `frontend`         | Vitest      | `__tests__/health.test.js`   |

**Gate:** si cualquier test falla, el pipeline se detiene y no avanza al SAST.

#### d) Seguridad del código – SAST (Semgrep)

```yaml
- name: SAST users-service
  run: |
    cd backend/users-service
    semgrep --config=auto --severity=ERROR --json --output=semgrep-users.json || true
    semgrep --config=auto --severity=ERROR

- name: SAST frontend
  run: |
    cd frontend
    semgrep --config=auto --severity=ERROR --json --output=semgrep-frontend.json || true
    semgrep --config=auto --severity=ERROR
```

Semgrep cubre los **4 componentes**: users-service, academic-service, api-gateway y **frontend**. El doble comando genera el reporte JSON (para evidencia como artefacto) y luego re-ejecuta con la salida que bloquea el pipeline si hay errores.

Además, el repositorio incluye reglas Semgrep personalizadas en `backend/semgrep-rules/`:

| Regla                    | Detecta                                      |
|--------------------------|----------------------------------------------|
| `hardcoded-secret.yaml`  | Credenciales, tokens o claves en el código   |
| `no-eval.yaml`           | Uso de `eval()` (riesgo de inyección de código)|
| `unvalidated-input.yaml` | Inputs no validados antes de su uso          |

**Gate:** si Semgrep detecta vulnerabilidades con severidad `ERROR`, el pipeline falla.

#### e) Seguridad de dependencias – SCA (Trivy)

```yaml
- name: Trivy scan users-service
  uses: aquasecurity/trivy-action@0.20.0
  with:
    image-ref: users-service
    severity: HIGH
    exit-code: 1

- name: Trivy scan academic-service
  uses: aquasecurity/trivy-action@0.20.0
  with:
    image-ref: academic-service
    severity: CRITICAL
    exit-code: 1
```

Trivy escanea las imágenes Docker construidas en busca de CVEs conocidos en:
- Librerías del sistema operativo base (Alpine/Debian)
- Dependencias de Node.js listadas en `package.json`

**Gate:** `exit-code: 1` hace que el pipeline falle ante vulnerabilidades `HIGH` o `CRITICAL`.

#### f) Build de contenedores + versionado del artefacto

```yaml
- name: Build Docker images
  run: |
    docker compose -f backend/docker-compose.yml build

- name: Tag Docker images with commit SHA (versionado)
  run: |
    SHA=${{ github.sha }}
    SHORT_SHA=${SHA::8}
    docker tag users-service    users-service:${SHORT_SHA}
    docker tag academic-service academic-service:${SHORT_SHA}
    docker tag api-gateway      api-gateway:${SHORT_SHA}
    docker tag frontend         frontend:${SHORT_SHA}
    echo "Images tagged with version: ${SHORT_SHA}"
```

Cada imagen queda versionada con el SHA corto del commit (ej: `users-service:a1b2c3d4`). Esto permite:
- Rastrear qué commit generó cada imagen.
- Rollback a una versión específica si se detecta un problema.
- Cumplir el principio de artefacto inmutable: cada build produce una versión única.

#### g) Seguridad de contenedores (Trivy)

El escaneo de Trivy (etapa `e`) actúa sobre las imágenes ya construidas (etapa `f`), cumpliendo el rol de **seguridad de contenedores**:

- Detecta vulnerabilidades del sistema base de la imagen.
- Detecta vulnerabilidades en librerías internas de Node.js.
- Detecta configuraciones inseguras en la imagen.

#### h) Smoke test

```yaml
- name: Run docker-compose
  run: |
    docker compose -f backend/docker-compose.yml up -d
    sleep 15

- name: Smoke test API Gateway
  run: |
    curl http://localhost:3000/health

- name: Shutdown services
  if: always()
  run: |
    docker compose -f backend/docker-compose.yml down
```

Verifica que los contenedores arrancan correctamente y el api-gateway responde. Se ejecuta `if: always()` en el shutdown para garantizar limpieza incluso si falla.

---

## 3. Justificación Técnica de Decisiones

### 3.1 Tabla resumen de herramientas

| Herramienta       | Etapa DevSecOps | Fase del pipeline    | Riesgo que mitiga                                          |
|-------------------|-----------------|----------------------|------------------------------------------------------------|
| **npm ci**        | Dev             | Instalación          | Builds no reproducibles, dependencias desactualizadas       |
| **ESLint**        | Dev / Code      | Calidad de código    | Malas prácticas, errores de sintaxis, vulnerabilidades de lógica |
| **Jest / Vitest** | Dev / Test      | Testing automático   | Regresiones funcionales, comportamiento no esperado         |
| **Semgrep**       | Sec / SAST      | Análisis estático    | Secrets hardcodeados, eval(), inputs no validados, SQLi, XSS|
| **Docker Compose**| Build           | Build de contenedores| Inconsistencias entre entornos (dev vs CI vs prod)          |
| **Trivy**         | Sec / SCA + Img | Seguridad de imagen  | CVEs en dependencias, OS base vulnerable, misconfigs        |
| **Smoke test**    | Ops / DAST lite | Deploy + test        | Regresiones en tiempo de ejecución, contenedores fallidos   |

### 3.2 ¿Por qué Semgrep?

Semgrep es un analizador estático de código (SAST) que trabaja sobre el **código fuente** antes de ejecutarlo. Es necesario porque:

1. **Detecta secretos hardcodeados** antes de que lleguen al repositorio (`hardcoded-secret.yaml`).
2. **Detecta uso de `eval()`** que puede derivar en ejecución arbitraria de código (`no-eval.yaml`).
3. **Detecta inputs no validados** que pueden causar inyecciones (`unvalidated-input.yaml`).
4. Trabaja en tiempo de desarrollo (shift-left), antes del build.
5. **Sin Semgrep:** un desarrollador podría commitear `const password = "admin123"` y pasar a producción sin ser detectado.

### 3.3 ¿Por qué Trivy?

Trivy actúa en dos fases de DevSecOps:

- **SCA (Software Composition Analysis):** escanea dependencias de `package.json` en busca de CVEs conocidos (base de datos NVD, GitHub Advisory).
- **Seguridad de contenedor:** escanea la imagen Docker construida (sistema operativo base + capas de Node.js).

Es necesario porque:

1. Una aplicación puede estar bien escrita pero usar una librería con CVE crítico (ej: `log4shell`, `prototype pollution`).
2. La imagen base de Docker puede tener vulnerabilidades del kernel o librerías del sistema.
3. **Sin Trivy:** podríamos desplegar un contenedor con una vulnerabilidad explotable activamente.

### 3.4 ¿Por qué npm ci en lugar de npm install?

`npm ci` garantiza:
- Instalación **exacta** de versiones especificadas en `package-lock.json`.
- **Falla explícitamente** si `package.json` y `package-lock.json` están desincronizados.
- Elimina `node_modules` antes de instalar (entorno limpio).

Esto previene ataques de **supply chain** donde una actualización silenciosa de dependencias introduce código malicioso.

### 3.5 ¿Por qué incluir tests incluso cuando el sistema es funcional?

Los tests automáticos son un **gate de seguridad funcional**:
- Previenen **regresiones** introducidas al añadir nuevas funcionalidades.
- Documentan el comportamiento esperado del sistema.
- En contexto DevSecOps, un test que falla puede indicar que un cambio de seguridad rompió funcionalidad crítica.

### 3.6 Integración DevSecOps del Login y Frontend

El pipeline cubre el frontend de manera explícita:

- **SAST:** Semgrep analiza el código del frontend en busca de vulnerabilidades (XSS, inputs no sanitizados, secrets en código JS).
- **SCA:** Trivy escanea la imagen Docker del frontend.
- **DAST lite:** El smoke test verifica que el api-gateway (que valida JWT del login) responde correctamente.
- **El login no se asume seguro:** se valida automáticamente en cada ejecución del pipeline.

---

## 4. Verificación y Evidencia de Ejecución del Pipeline

### 4.1 Disparar el pipeline en GitHub Actions

```bash
# 1. Commitear todos los cambios
git add .
git commit -m "feat: pipeline CI/CD DevSecOps completo con SAST, SCA y gates"
git push origin main
```

Inmediatamente GitHub Actions ejecuta el workflow `DevSecOps CI/CD Pipeline`.

### 4.2 Obtener evidencia paso a paso

#### Paso 1 – Ir a la pestaña Actions

```
https://github.com/W-Varg/Practica2/actions
```

Se verá la lista de ejecuciones. Un círculo **verde ✅** indica éxito, **rojo ❌** indica fallo con gate activado.

#### Paso 2 – Abrir la ejecución y capturar pantalla

Dentro de la ejecución, hacer clic en el job `devsecops` para ver todos los steps. Tomar captura de:

1. **Vista general** del job con todos los steps marcados como ✅ o ❌  
2. **Step: Install & Test users-service** → log con `Tests: X passed`  
3. **Step: ESLint – frontend** → log con `0 errors`  
4. **Step: SAST users-service** → log de Semgrep sin hallazgos ERROR  
5. **Step: SAST frontend** → log de Semgrep para código React/JS  
6. **Step: Trivy scan users-service** → tabla de CVEs encontrados/no encontrados  
7. **Step: Smoke test API Gateway** → respuesta `{"status":"api-gateway OK"}`  

#### Paso 3 – Descargar artefactos generados automáticamente

El pipeline guarda reportes automáticamente. Al final de la ejecución, en la sección **Artifacts**:

| Artefacto           | Contenido                                              |
|---------------------|--------------------------------------------------------|
| `semgrep-reports`   | JSON con resultados SAST de los 4 servicios            |
| `trivy-reports`     | Tablas con CVEs encontrados en las 4 imágenes Docker   |

Para descargarlos:
```
Actions → [run] → Artifacts (al final de la página) → Download
```

#### Paso 4 – Obtener el link directo a la ejecución

Copiar la URL de la ejecución, ejemplo:
```
https://github.com/W-Varg/Practica2/actions/runs/XXXXXXXXX
```
Este link es evidencia pública de la ejecución.

### 4.3 Tabla de indicadores de éxito

| Etapa                        | Indicador de éxito                                          | Gate |
|------------------------------|-------------------------------------------------------------|------|
| Install & Test               | `npm test` → `Tests: X passed, 0 failed`                   | ✅   |
| ESLint                       | `0 errors, 0 warnings`                                      | ✅   |
| SAST Semgrep (x4)            | `Findings: 0 matches` con severidad ERROR                   | ✅   |
| Build Docker                 | `docker compose build` completa sin errores                 | ✅   |
| Trivy scan (x4)              | Sin CVEs HIGH/CRITICAL → job continúa; si hay → job falla  | ✅   |
| Smoke test                   | `curl /health` → `{"status":"api-gateway OK"}`              | ✅   |

### 4.4 Verificación manual antes del push

```bash
# Construir imágenes localmente
cd backend
docker compose build

# Ejecutar tests de cada servicio
cd users-service  && npm ci && npm test && cd ..
cd academic-service && npm ci && npm test && cd ..
cd api-gateway    && npm ci && npm test && cd ..
cd ../frontend    && npm ci && npm test && npm run lint && cd ..

# Ejecutar Semgrep manualmente
pip install semgrep
semgrep --config=auto --severity=ERROR backend/users-service/
semgrep --config=auto --severity=ERROR backend/academic-service/
semgrep --config=auto --severity=ERROR backend/api-gateway/
semgrep --config=auto --severity=ERROR frontend/src/

# Ejecutar Trivy manualmente (requiere trivy instalado)
trivy image users-service   --severity HIGH,CRITICAL
trivy image academic-service --severity HIGH,CRITICAL
trivy image api-gateway     --severity HIGH,CRITICAL
trivy image frontend        --severity HIGH,CRITICAL

# Smoke test completo
docker compose -f backend/docker-compose.yml up -d
sleep 15
curl -s http://localhost:3000/health
docker compose -f backend/docker-compose.yml down
```

### 4.5 Enlace a ejecuciones del pipeline

- **Repositorio fork:** https://github.com/W-Varg/Practica2  
- **GitHub Actions:** https://github.com/W-Varg/Practica2/actions  
- **Workflow file:** [`.github/workflows/devsecops.yml`](.github/workflows/devsecops.yml)

---

## 5. Estructura de Entregables

```
Practica2/
├── .github/
│   └── workflows/
│       └── devsecops.yml          ← Pipeline CI/CD completo
├── backend/
│   ├── docker-compose.yml         ← Orquestación de contenedores
│   ├── users-service/             ← Microservicio de autenticación JWT
│   ├── academic-service/          ← Microservicio de cursos
│   ├── api-gateway/               ← Gateway con validación JWT
│   └── semgrep-rules/             ← Reglas SAST personalizadas
│       ├── hardcoded-secret.yaml
│       ├── no-eval.yaml
│       └── unvalidated-input.yaml
├── frontend/                      ← SPA React con login y cursos
├── k8s/                           ← Manifiestos Kubernetes
│   ├── namespace.yaml
│   ├── users-service/
│   ├── academic-service/
│   ├── api-gateway/
│   └── frontend/
├── tarea2.md                      ← Este documento (justificación técnica)
└── Readme.md                      ← Guía de despliegue
```

---

## 6. Resumen del Enfoque DevSecOps

```
PLAN ──► CODE ──► BUILD ──► TEST ──► RELEASE ──► DEPLOY ──► OPERATE
         │         │         │          │
       ESLint    Docker    Jest/    Semgrep (SAST)
       Semgrep   Build     Vitest   Trivy (SCA + img)
       npm ci              Smoke
                           test
```

El principio **shift-left** se aplica en esta práctica:
- La seguridad no es un paso final, es una condición de avance en cada etapa.
- Cada herramienta actúa como un **gate**: si falla, el código no avanza.
- El pipeline convierte la seguridad en un proceso automático, no manual.

> **"El login no se asume seguro, se valida automáticamente."**  
> El pipeline garantiza que cada cambio en el código de autenticación pasa por SAST, SCA y smoke tests antes de integrarse a la rama principal.
