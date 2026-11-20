# Flipper Puente

App Android (React Native + Expo) que se conecta a un **Flipper Zero** por Bluetooth y permite:

| Pestaña | Qué hace |
|---|---|
| **Conectar** | Busca Flippers cercanos, se empareja (PIN en la pantalla del Flipper) y muestra firmware y batería. |
| **Archivos** | Navega la tarjeta SD (`/ext`) y la memoria interna (`/int`). Subir archivos del celular, crear carpetas, renombrar, eliminar (incluso carpetas completas), ver/editar archivos de texto, compartir un archivo y copiar una carpeta entera al celular. |
| **Comandos** | Ver la pantalla del Flipper en vivo y controlarlo con los botones. Ping, info, batería, espacio de la SD, sincronizar la hora, alerta (LED + vibración), reiniciar, abrir y cerrar apps. |
| **Internet** | Puente de internet: la app **Puente Internet** del Flipper le pide páginas al celular y este las descarga con sus datos o su Wi‑Fi. También puedes mandar mensajes a la pantalla del Flipper. |

No hizo falta ingeniería inversa. El Flipper habla un protocolo **RPC oficial y abierto** (protobuf sobre un "servicio serial" Bluetooth). Las definiciones del protocolo salen de `flipperdevices/flipperzero-protobuf` y los UUID de Bluetooth del firmware oficial.

```
flipper-puente-proyecto/
├── app-escritorio/            ← app para Windows por USB (Electron) → ver app-escritorio/README.md
├── app-movil/                 ← proyecto Expo (genera el APK)
│   ├── App.tsx                ← pestañas
│   ├── src/transport/         ← Bluetooth LE + control de flujo del Flipper
│   ├── src/rpc/               ← cliente RPC (protobuf) y API de alto nivel
│   ├── src/bridge/            ← lado del celular del puente de internet
│   ├── src/screens/           ← pantallas
│   ├── src/proto/             ← código generado desde proto/*.proto
│   └── tests/                 ← prueba con un "Flipper falso" (sin hardware)
└── app-flipper/internet_bridge/  ← app para el Flipper (.fap, en C)
```

¿En la PC? **`app-escritorio/`** es la versión de escritorio para Windows. Se conecta por cable USB y trae lo mismo más la consola de comandos completa del Flipper: `cd app-escritorio && npm install && npm start`.

---

## 1. Generar el APK

> No funciona con **Expo Go**, porque usa Bluetooth (módulo nativo). Hay que compilar el APK.

### Opción A — en la nube con EAS (no necesitas Android Studio)

```bash
cd app-movil
npm install
npx eas-cli@latest login            # cuenta gratuita de expo.dev
npx eas-cli@latest build -p android --profile preview
```

Al terminar (unos 10 a 20 minutos), EAS te da un enlace y un QR para descargar el `.apk`. Lo instalas en el celular, aceptando "instalar apps de origen desconocido".

### Opción B — en tu PC (Android Studio + JDK 17)

```bash
cd app-movil
npm install
npx expo prebuild -p android
cd android
./gradlew assembleRelease           # en Windows: gradlew.bat assembleRelease
```

El APK queda en `android/app/build/outputs/apk/release/app-release.apk`.

Para desarrollar con recarga en caliente, conecta el celular por USB y ejecuta `npx expo run:android`.

## 2. Compilar e instalar la app del Flipper (Puente Internet)

Solo se necesita para la pestaña **Internet**. Archivos y Comandos funcionan sin ella.

```bash
pip install ufbt
cd app-flipper/internet_bridge
ufbt                    # compila → dist/internet_bridge.fap
ufbt launch             # (opcional) con el Flipper por USB: la instala y la abre
```

Para instalarla sin cable, pasa `internet_bridge.fap` al celular y, en la pestaña **Internet**, usa **"Instalar/actualizar .fap desde el celular"**. Queda guardada en `/ext/apps/Tools/internet_bridge.fap`.

> ufbt descarga el SDK del firmware **oficial (release)**. Si tu Flipper tiene un firmware personalizado (Momentum, Unleashed…), compílala con el SDK de ese firmware; su documentación explica cómo apuntar ufbt a él.

## 3. Uso

1. En el Flipper: **Settings → Bluetooth → ON**. Cierra la app oficial de Flipper en el celular, porque solo una app puede estar conectada a la vez.
2. Abre **Flipper Puente**, ve a **Conectar**, toca **Buscar Flippers** y elige el tuyo. La primera vez el Flipper muestra un PIN: acéptalo en el celular.
3. **Internet:** toca **"Abrir puente en el Flipper"**. En el Flipper aparece un menú (Mi IP pública, Clima, Chiste, Abrir URL…). Lo que elijas lo descarga el celular y la respuesta se ve en el Flipper. La página llega resumida a unos 1900 caracteres de texto ASCII, porque la pantalla y la memoria del Flipper son pequeñas.

### Protocolo del puente (por si quieres extenderlo)

Viaja dentro de `PB_App.DataExchangeRequest`, en texto UTF‑8:

| Dirección | Mensaje |
|---|---|
| Flipper → celular | `HELLO` · `GET <url>` |
| Celular → Flipper | `OK <código HTTP>\n<texto>` · `ERR <motivo>` · `MSG <texto libre>` |

Para agregar comandos nuevos, como pedir el clima de una ciudad o leer notificaciones, edita `handleRequest()` en `src/bridge/InternetBridge.ts` y `menu_callback()` en `internet_bridge.c`.

## 4. Pruebas

```bash
cd app-movil
npm run typecheck      # TypeScript
npm test               # cliente RPC, archivos y puente contra un Flipper simulado
```

## Límites conocidos

- Por Bluetooth el Flipper expone su **RPC**, no la consola de texto (CLI). Los "comandos" disponibles son los del RPC: archivos, apps, botones, pantalla, sistema. Una consola completa necesitaría conexión **USB‑OTG** (se puede agregar como otro `Transport`).
- La velocidad de Bluetooth es de unos pocos KB/s: los archivos grandes tardan.
- Eliminar en el Flipper es **permanente**: no hay papelera.
- Probado en simulación y compilación; falta la prueba en hardware real con tu Flipper.
