# Bitácora de aprendizaje

## 1. Conceptos que no dominaba al empezar

**Que un guardarraíl escrito en el prompt no es un guardarraíl.** Empecé asumiendo
que instruir bien al modelo bastaba. El enunciado exige G1–G5 «fuera del prompt» y
al principio lo leí como una preferencia de estilo. No lo es: una instrucción es
una petición, y el modelo puede ignorarla. Lo entendí de verdad al escribir el
caso de inyección: el prompt le dice al agente que `destino_fondos` no es una
orden, pero lo que impide que la inyección tenga efecto es que ninguna
herramienta acepta parámetros derivados de ese campo y que la verificación de
citas corre en código después, pase lo que pase.

**Que un `CHECK` de PostgreSQL solo ve columnas de su propia fila.** Esto
reescribió el diseño de G3. Para que la restricción pudiera comparar el monto
recomendado contra el solicitado y contra el tope de política, hubo que
materializar ambos valores en la fila del dictamen. Y eso abrió el problema
interesante: si los escribe la aplicación, basta con mandar un tope inflado para
burlar el `CHECK`. Los escribe un trigger.

**Dónde redondear en una tabla de amortización.** Sabía que el dinero no va en
punto flotante. No sabía que la decisión difícil no es el tipo sino el resto: en
qué cuota cae la diferencia, y por qué mitad-al-par en vez de mitad-arriba. Sobre
100 000 empates, la primera acumula 0.00 de sesgo y la segunda +500.00 cobrados
de más sin ninguna base.

## 2. Qué consulté y cómo lo verifiqué

Usé documentación oficial de PostgreSQL para las restricciones diferidas y para
por qué `unaccent` no es inmutable. Lo verifiqué ejecutándolo: la columna generada
falló hasta que envolví la función fijando el diccionario.

Para los modelos no me fié de ninguna lista: consulté el catálogo de OpenRouter
por API. Los tres que había elegido al planificar **ya no eran gratuitos** y
devolvían 404.

La regla que acabé aplicando con todo lo que venía de un modelo de lenguaje:
**convertirlo en una comprobación ejecutable**. Un test que falla verifica mejor
que una segunda opinión. El ejemplo más claro es la fórmula de anualidad: en vez
de aceptar la implementación, la contrasté contra una escrita aparte en Python
con su módulo `decimal`. Coinciden al centavo a 24, 36, 240 y 360 meses. Si
hubiera comparado el código consigo mismo, la prueba no valdría nada.

## 3. Una decisión que cambié a mitad de camino

Tenía previsto búsqueda vectorial con embeddings locales. La descarté al medir el
corpus real una vez construido: **32 políticas**. Recorrerlas enteras cuesta
microsegundos y da recall perfecto; añadir una inferencia de CPU por consulta
habría sido más lento, menos exacto y más difícil de auditar a cambio de nada.

Pero el cambio que más me enseñó fue otro, y más incómodo. Iba a escribir en el
banco de pruebas que «sin el cierre por excepciones, la excepción se pierde». Lo
medí antes de darlo por bueno y **era falso**: con consultas que casi citan la
norma, BM25 ya trae la excepción sola. El valor del cierre está en las
paráfrasis, que es como el agente formula las consultas de verdad — con «el flujo
no alcanza para pagar la cuota», el ranking pierde POL-7.7 y solo el cierre la
recupera. Reescribí el test para que midiera eso. Estuve a punto de dejar una
afirmación falsa en la documentación por no haberla comprobado.

## 4. Qué haría con una semana más

**Recuperación vectorial**, no por completitud sino por la limitación que dejé
declarada como comprobación explícita: BM25 no relaciona «empresa recién
constituida» con «24 meses continuos de operación». El reranking conceptual que
sí construí (M19) cierra tres casos concretos de esa limitación, pero sigue sin
resolverla en general — una paráfrasis fuera de los conceptos curados sigue sin
recuperar nada, y eso es exactamente lo que la recuperación vectorial sí
resolvería de raíz.

**Evaluar más de una vez por caso.** Con modelos no deterministas, un solo intento
mide poco: durante el desarrollo vi la misma solicitud terminar en dictamen
registrado y, en otra ejecución, agotar las iteraciones sin decidir. Diez casos a
una ejecución cada uno no distinguen un fallo sistemático de una mala tirada.

**Vigencia temporal efectiva en el corpus.** Las columnas ya existen; falta usarlas
para poder releer un dictamen de hace seis meses contra el corpus que estaba
vigente entonces, y no contra el de hoy.
