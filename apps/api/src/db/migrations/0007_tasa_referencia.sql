-- ---------------------------------------------------------------------------
-- 0007 · Tasa de interes de referencia.
--
-- La cobertura de servicio de deuda del punto 5.3.1 depende de la cuota anual
-- del credito nuevo, y esa cuota depende de una tasa que no viene en la
-- solicitud. La tasa vive aqui, junto a los demas umbrales que aplican los
-- guardarrailes, y no como constante suelta en el codigo, por dos razones:
--
--   1. Cada calculo guarda la tasa que aplico (indicadores_solicitud.
--      tasa_anual_aplicada). Seis meses despues, un auditor puede reproducir
--      el indicador exacto sin adivinar con que tasa se calculo.
--   2. Al estar respaldada por POL-10.1, el dictamen puede CITAR de donde sale
--      la tasa. Un numero que cambia el resultado del analisis y no se puede
--      citar es justo el tipo de criterio no documentado que el punto 5.1
--      describe como hallazgo recurrente de auditoria.
--
-- El vinculo con POL-10.1 lo establece el cargador del corpus, porque la
-- politica todavia no existe cuando corre esta migracion.
-- ---------------------------------------------------------------------------

INSERT INTO parametros_politica (clave, valor, descripcion) VALUES
  ('tasa_anual_referencia', 0.18,
   'Tasa de interes anual de referencia para creditos PyME, sobre saldos (POL-10.1)')
ON CONFLICT (clave) DO NOTHING;
