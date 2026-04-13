# Portal Vacacional SSMX

## Ver cambios de estatus (admin → portal)

El estatus **Supervisor / Gerente Dpto / RH** se guarda en `localStorage` del **mismo origen** (misma URL base).

- Si abres los archivos con **doble clic** (`file:///...`), el navegador puede tratar `portal.html` y `admin.html` como **orígenes distintos** y **no compartir** datos entre ellos. En ese caso los cambios del admin **no** aparecerán en el portal.

**Recomendación:** servir la carpeta del proyecto por HTTP, por ejemplo:

```bash
cd vacaciones-portal
python -m http.server 8080
```

Luego abre en el navegador: `http://localhost:8080/index.html`

(En VS Code/Cursor puedes usar la extensión **Live Server** de la misma forma.)

Con un solo origen (`http://localhost:...`), el portal puede actualizar el estatus en vivo (eventos + sondeo ligero).
