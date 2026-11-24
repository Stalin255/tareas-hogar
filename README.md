# Tareas del Hogar

PWA familiar con sincronización Socket.io, roles protegidos, desvinculación de perfiles y notas compartidas por zona. Render sirve la aplicación por HTTPS y el proceso Node.js escucha por HTTP en el puerto que Render proporciona.

## Desarrollo local

Requiere Node.js 18 o superior y npm.

```sh
npm.cmd install
npm.cmd start
```

En local, el estado se conserva en `data.json`. El archivo se ignora en Git.

## Despliegue en Render

- Crea un Web Service desde este repositorio.
- Usa `npm install` como Build Command y `npm start` como Start Command.
- Configura un servicio Redis HTTP en Upstash y agrega `UPSTASH_REDIS_REST_URL` y `UPSTASH_REDIS_REST_TOKEN` como variables de entorno del servicio.
- Render termina HTTPS delante del proceso HTTP; la app escucha en `0.0.0.0:$PORT` y `/health` sirve para la comprobación de salud.

Redis guarda el estado completo bajo `tareas_hogar_state`; si no hay credenciales o Redis falla, la aplicación usa `data.json` como respaldo local. La zona horaria diaria y el ciclo de roles usan `America/Guayaquil`.

El estado inicial conserva las cuatro zonas originales con sus 18 tareas y añade BAÑO, compartido por Libro y Angel.
