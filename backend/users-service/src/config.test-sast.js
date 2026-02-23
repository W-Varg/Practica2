// ARCHIVO TEMPORAL - solo para demostrar gate SAST de Semgrep
// Este commit debe generar un fallo en el pipeline (evidencia de gate activo)
// Será revertido en el siguiente commit

const db_password = "admin1234";  // semgrep: hardcoded-secret → debe fallar
const api_key = "sk-abc123xyz";   // semgrep: hardcoded-secret → debe fallar
