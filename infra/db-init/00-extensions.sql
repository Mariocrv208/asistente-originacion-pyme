-- Se ejecuta una sola vez, al inicializar el volumen de datos.
-- Las migraciones del esquema viven en apps/api/src/db/migrations (modulo M2);
-- aqui solo quedan las extensiones, que requieren privilegios de superusuario.

CREATE EXTENSION IF NOT EXISTS vector;      -- pgvector: recuperacion vectorial (M6)
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- similitud por trigramas: recuperacion lexica (M6)
CREATE EXTENSION IF NOT EXISTS unaccent;    -- normalizacion de acentos: verificacion de citas G1
CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- gen_random_uuid() para las claves primarias
