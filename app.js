// Firebase init (temporal básico)
const firebaseConfig = {
  apiKey: "AIzaSyANEg1_42fxRixxH_oqYwISMJ8ZOi5fwiM",
  authDomain: "vacaciones-portal.firebaseapp.com",
  projectId: "vacaciones-portal",
  storageBucket: "vacaciones-portal.firebasestorage.app",
  messagingSenderId: "464510476525",
  appId: "1:464510476525:web:e5d9d2a7ef72ad620d2ce4",
  measurementId: "G-STSFVQ5Q4Z"
};

let db = null;
window.__firebaseStatus = "not_initialized";
window.__firebaseAuthReady = Promise.resolve(null);
window.__firebaseAuthStatus = "not_started";

try {
  if (typeof firebase !== "undefined") {
    if (!firebase.apps.length) {
      firebase.initializeApp(firebaseConfig);
    }
    db = firebase.firestore();
    window.db = db;
    window.__firebaseStatus = "ok";
    console.log("[Firebase] inicializado OK");

    if (typeof firebase.auth === "function") {
      const auth = firebase.auth();
      window.__firebaseAuthReady = (function () {
        try {
          const cur = auth.currentUser;
          if (cur) {
            window.__firebaseAuthUid = cur.uid;
            window.__firebaseAuthStatus = "session_ok";
            return Promise.resolve(cur);
          }
        } catch (e) {
          /* ignore */
        }
        return auth
          .signInAnonymously()
          .then(function (cred) {
            const u = cred && cred.user;
            window.__firebaseAuthUid = u ? u.uid : "";
            window.__firebaseAuthStatus = "anonymous_ok";
            console.log("[Firebase] sesión anónima OK (Firestore con reglas request.auth)");
            return u;
          })
          .catch(function (authErr) {
            const c = authErr && authErr.code != null ? String(authErr.code) : "";
            const m =
              authErr && authErr.message != null
                ? String(authErr.message)
                : String(authErr);
            window.__firebaseAuthStatus = c ? c + ": " + m : m;
            console.warn(
              "[Firebase] signInAnonymously falló — en Console activa Authentication → Anonymous y revisa reglas:",
              authErr
            );
            return null;
          });
      })();
    } else {
      window.__firebaseAuthStatus = "auth_sdk_missing";
    }
  } else {
    window.__firebaseStatus = "sdk_missing";
    window.__firebaseAuthStatus = "sdk_missing";
    console.warn("[Firebase] SDK no cargado");
  }
} catch (err) {
  window.__firebaseStatus = "error";
  window.__firebaseError = String(err && err.message ? err.message : err);
  window.__firebaseAuthStatus = "init_error";
  console.error("[Firebase] error al inicializar:", err);
}

function whenFirebaseAuthReady() {
  return window.__firebaseAuthReady || Promise.resolve(null);
}

/**
 * Respaldo en la nube: guarda una solicitud del portal en Firestore.
 * No reemplaza localStorage por ahora; se ejecuta en paralelo como copia central.
 */
function buildSolicitudReadableFolio(operatorId) {
  const d = new Date();
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  const sec = String(d.getSeconds()).padStart(2, "0");
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `SOL-${String(operatorId)}-${yyyy}${mm}${dd}-${hh}${min}${sec}-${rand}`;
}

function backupPortalRequestToFirestore(opId, payload, tipo) {
  if (!db) return Promise.resolve(null);
  const operatorId = String(opId || "").trim();
  if (!operatorId || !payload || typeof payload !== "object") {
    return Promise.resolve(null);
  }

  const motive =
    payload && payload.motive != null ? String(payload.motive).trim() : "";
  const values =
    payload && payload.values && typeof payload.values === "object"
      ? payload.values
      : {};
  let operatorName = "";
  try {
    operatorName = String(resolveHistoryFooterOperatorNombre(operatorId) || "").trim();
  } catch (e) {
    operatorName = "";
  }
  const folio = buildSolicitudReadableFolio(operatorId);

  const doc = {
    folio: folio,
    operatorId: operatorId,
    operatorName: operatorName || "Operador " + operatorId,
    tipo: String(tipo || "Solicitud"),
    motive: motive,
    payload: payload,
    values: values,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    source: "portal",
    status: "pendiente",
  };

  return whenFirebaseAuthReady()
    .then(function () {
      if (!db) return null;
      return db
        .collection("solicitudes")
        .doc(folio)
        .set(doc)
        .then(function () {
          console.log(
            "[Firestore] solicitud respaldada | folio:",
            folio
          );
          try {
            if (window.__firestoreHistorialByOperator && operatorId) {
              delete window.__firestoreHistorialByOperator[operatorId];
            }
          } catch (e) {
            /* ignore */
          }
          const histContent = document.getElementById("portalHistoryContent");
          if (
            histContent &&
            histContent.style.display !== "none" &&
            operatorId
          ) {
            refreshPortalHistoryFromFirestore(operatorId);
          }
          return folio;
        });
    })
    .catch(function (err) {
      console.warn("[Firestore] no se pudo respaldar solicitud:", err);
      return null;
    });
}

/** Cache en memoria: historial remoto por operador (portal + admin «solo operador»). */
window.__firestoreHistorialByOperator = window.__firestoreHistorialByOperator || {};
/** Lista plana para admin «todos» (últimas N por fecha en Firestore). */
window.__firestoreHistorialAll = window.__firestoreHistorialAll || null;

const FIRESTORE_SOLICITUDES_LIMIT_ALL = 200;

function firestoreDocToHistoryEntry(docSnap) {
  const d = docSnap.data() || {};
  const createdAt = d.createdAt;
  let ts = Date.now();
  if (createdAt && typeof createdAt.toMillis === "function") {
    ts = createdAt.toMillis();
  } else if (createdAt && typeof createdAt.seconds === "number") {
    ts = createdAt.seconds * 1000;
  }
  const statusRaw = String(d.status != null ? d.status : "pendiente")
    .trim()
    .toLowerCase();
  let estadoHistorial = "pendiente";
  if (statusRaw === "aprobado") estadoHistorial = "aprobado";
  else if (statusRaw === "rechazado") estadoHistorial = "rechazado";
  else if (
    statusRaw === "na" ||
    statusRaw === "archivada" ||
    statusRaw === "n/a"
  ) {
    estadoHistorial = "na";
  }

  const operatorId = String(d.operatorId != null ? d.operatorId : "").trim();
  const operatorName =
    d.operatorName != null ? String(d.operatorName).trim() : "";

  let payload = d.payload;
  if (!payload || typeof payload !== "object") payload = {};

  return {
    ts: ts,
    tipo: d.tipo != null ? String(d.tipo) : "Solicitud",
    payload: payload,
    estadoHistorial: estadoHistorial,
    operatorId: operatorId,
    operatorName: operatorName,
    fromFirestore: true,
    firestoreFolio: d.folio != null ? String(d.folio) : docSnap.id,
  };
}

function pickLatestFirestoreSolicitudDocSnapForOperator(opId) {
  const id = String(opId || "").trim();
  if (!id || !db) return Promise.resolve(null);
  return whenFirebaseAuthReady()
    .then(function () {
      if (!db) return null;
      return db
        .collection("solicitudes")
        .where("operatorId", "==", id)
        .get();
    })
    .then(function (qs) {
      if (!qs || !qs.docs || !qs.docs.length) return null;
      let best = null;
      let bestTs = -Infinity;
      for (let i = 0; i < qs.docs.length; i++) {
        const d = qs.docs[i];
        const e = firestoreDocToHistoryEntry(d);
        const t = e && e.ts ? e.ts : 0;
        if (t > bestTs) {
          bestTs = t;
          best = d;
        }
      }
      return best;
    });
}

function normalizeSolicitudFirestoreStatusForDoc(val) {
  const raw = String(val || "").trim().toLowerCase();
  if (raw === "aprobado" || raw === "autorizado") return "aprobado";
  if (raw === "rechazado") return "rechazado";
  if (raw === "na" || raw === "archivada" || raw === "n/a") return "archivada";
  return "pendiente";
}

/**
 * Actualiza el campo `status` del documento de solicitud más reciente del operador en Firestore.
 * Así, si se borran cookies/datos locales, el historial reconstruido desde la nube conserva
 * aprobado/rechazado/archivada en lugar de quedar todo en pendiente.
 */
function syncOperatorLatestSolicitudFirestoreStatus(opId, desiredStatus) {
  const id = String(opId || "").trim();
  if (!id || !db) return Promise.resolve(false);
  const norm = normalizeSolicitudFirestoreStatusForDoc(desiredStatus);
  let folioHint = "";
  try {
    const h = getAdminRequestHistory(id);
    if (h.length) {
      const li = latestHistoryEntryIndex(h);
      const entry = h[li];
      if (entry && entry.firestoreFolio) {
        folioHint = String(entry.firestoreFolio).trim();
      }
    }
  } catch (e) {
    /* ignore */
  }

  function invalidateFsHistorialCaches() {
    try {
      if (
        window.__firestoreHistorialByOperator &&
        window.__firestoreHistorialByOperator[id]
      ) {
        delete window.__firestoreHistorialByOperator[id];
      }
      if (Array.isArray(window.__firestoreHistorialAll)) {
        window.__firestoreHistorialAll = null;
      }
    } catch (e2) {
      /* ignore */
    }
  }

  function applyDoc(docSnap) {
    if (!docSnap || !docSnap.ref) return Promise.resolve(false);
    return docSnap.ref
      .set(
        {
          status: norm,
          statusUpdatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
      .then(function () {
        invalidateFsHistorialCaches();
        return true;
      })
      .catch(function (err) {
        console.warn("[Firestore] no se pudo actualizar status de solicitud:", err);
        return false;
      });
  }

  return whenFirebaseAuthReady().then(function () {
    if (!db) return Promise.resolve(false);
    if (folioHint) {
      return db
        .collection("solicitudes")
        .doc(folioHint)
        .get()
        .then(function (snap) {
          if (snap && snap.exists) return applyDoc(snap);
          return pickLatestFirestoreSolicitudDocSnapForOperator(id).then(applyDoc);
        });
    }
    return pickLatestFirestoreSolicitudDocSnapForOperator(id).then(applyDoc);
  });
}

window.__solicitudFsStatusBackfillCache =
  window.__solicitudFsStatusBackfillCache || Object.create(null);

function mapHistorialEstadoToFirestoreStatusField(estadoHistorial) {
  const n = normalizeHistorialEstadoStored(estadoHistorial);
  if (n === "aprobado") return "aprobado";
  if (n === "rechazado") return "rechazado";
  if (n === "na") return "archivada";
  return "";
}

/**
 * Historial local antiguo sin `firestoreFolio`: empareja con la fila remota (mismo motivo y
 * marca de tiempo cercana) para poder persistir el estado en el documento correcto.
 */
function attachFirestoreFolioFromRemoteForEntry(entry, remoteArr) {
  if (
    !entry ||
    (entry.firestoreFolio && String(entry.firestoreFolio).trim() !== "")
  ) {
    return entry;
  }
  if (!remoteArr || !remoteArr.length) return entry;
  const motive =
    entry.payload && entry.payload.motive != null
      ? String(entry.payload.motive)
      : "";
  const t2 = entry && entry.ts ? entry.ts : 0;
  let bestFolio = "";
  let bestDt = Infinity;
  for (let i = 0; i < remoteArr.length; i++) {
    const r = remoteArr[i];
    const rm =
      r && r.payload && r.payload.motive != null
        ? String(r.payload.motive)
        : "";
    if (rm !== motive) continue;
    const t1 = r && r.ts ? r.ts : 0;
    const dt = Math.abs(t1 - t2);
    if (dt < 20000 && dt < bestDt) {
      const f =
        r && r.firestoreFolio ? String(r.firestoreFolio).trim() : "";
      if (f) {
        bestDt = dt;
        bestFolio = f;
      }
    }
  }
  if (!bestFolio) return entry;
  return Object.assign({}, entry, { firestoreFolio: bestFolio });
}

/**
 * Si la fila ya muestra aprobado/rechazado/archivada pero Firestore sigue en pendiente,
 * reescribe `status` en el doc (migración suave en una visita con datos locales).
 */
function backfillSolicitudFirestoreStatusIfNeeded(entry) {
  const folio =
    entry && entry.firestoreFolio
      ? String(entry.firestoreFolio).trim()
      : "";
  if (!folio || !db) return;
  const fsStatus = mapHistorialEstadoToFirestoreStatusField(
    entry.estadoHistorial
  );
  if (!fsStatus) return;
  const cache = window.__solicitudFsStatusBackfillCache;
  if (cache[folio] === fsStatus) return;
  cache[folio] = fsStatus;
  whenFirebaseAuthReady()
    .then(function () {
      if (!db) return;
      return db
        .collection("solicitudes")
        .doc(folio)
        .set(
          {
            status: fsStatus,
            statusUpdatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
    })
    .then(function () {
      try {
        const oid =
          entry &&
          entry.operatorId != null &&
          String(entry.operatorId).trim() !== ""
            ? String(entry.operatorId).trim()
            : "";
        if (oid && window.__firestoreHistorialByOperator) {
          delete window.__firestoreHistorialByOperator[oid];
        }
        window.__firestoreHistorialAll = null;
      } catch (e) {
        /* ignore */
      }
    })
    .catch(function (err) {
      console.warn("[Firestore] backfill status solicitud:", err);
      delete window.__solicitudFsStatusBackfillCache[folio];
    });
}

/**
 * Combina historial local y copias en Firestore; si hay duplicado cercano en tiempo y mismo
 * motivo, se conserva la fila con estado más sólido (evita que Firestore pendiente pise
 * un aprobado/rechazado/archivada ya persistido en local).
 */
function historialEstadoMergeWeight(val) {
  const n = normalizeHistorialEstadoStored(val);
  if (n === "aprobado" || n === "rechazado") return 3;
  if (n === "na") return 2;
  if (n === "pendiente") return 1;
  return 0;
}

function mergeDuplicateHistoryEntries(existing, incoming) {
  const we = historialEstadoMergeWeight(existing && existing.estadoHistorial);
  const wi = historialEstadoMergeWeight(incoming && incoming.estadoHistorial);
  const winner = wi > we ? incoming : existing;
  const loser = wi > we ? existing : incoming;
  const merged = Object.assign({}, winner);
  if (
    (!merged.operatorName || String(merged.operatorName).trim() === "") &&
    loser &&
    loser.operatorName
  ) {
    merged.operatorName = loser.operatorName;
  }
  if (
    (!merged.operatorId || String(merged.operatorId).trim() === "") &&
    loser &&
    loser.operatorId
  ) {
    merged.operatorId = loser.operatorId;
  }
  if (
    (!merged.firestoreFolio || String(merged.firestoreFolio).trim() === "") &&
    loser &&
    loser.firestoreFolio &&
    String(loser.firestoreFolio).trim() !== ""
  ) {
    merged.firestoreFolio = String(loser.firestoreFolio).trim();
  }
  const mergedEstado = normalizeHistorialEstadoStored(merged.estadoHistorial);
  if (
    mergedEstado === "na" &&
    !isMaestroArchivadaMarker(merged) &&
    loser &&
    isMaestroArchivadaMarker(loser)
  ) {
    merged.maestroResetArchivada = true;
  } else if (
    (mergedEstado === "aprobado" || mergedEstado === "rechazado") &&
    isMaestroArchivadaMarker(merged)
  ) {
    delete merged.maestroResetArchivada;
  }
  return merged;
}

function mergeHistoryEntriesPreferFirestore(localArr, remoteArr) {
  const merged = [];
  const all = []
    .concat((remoteArr || []).map(function (e) {
      return { entry: e, src: "fs" };
    }))
    .concat((localArr || []).map(function (e) {
      return { entry: e, src: "loc" };
    }));
  all.sort(function (a, b) {
    const ta = a.entry && a.entry.ts ? a.entry.ts : 0;
    const tb = b.entry && b.entry.ts ? b.entry.ts : 0;
    return tb - ta;
  });
  for (let i = 0; i < all.length; i++) {
    const e = all[i].entry;
    const src = all[i].src;
    const motive =
      e && e.payload && e.payload.motive != null
        ? String(e.payload.motive)
        : "";
    let dupIdx = -1;
    for (let j = 0; j < merged.length; j++) {
      const o = merged[j].entry;
      const om =
        o && o.payload && o.payload.motive != null
          ? String(o.payload.motive)
          : "";
      const t1 = o && o.ts ? o.ts : 0;
      const t2 = e && e.ts ? e.ts : 0;
      if (motive === om && Math.abs(t1 - t2) < 20000) {
        dupIdx = j;
        break;
      }
    }
    if (dupIdx >= 0) {
      const current = merged[dupIdx];
      merged[dupIdx] = {
        entry: mergeDuplicateHistoryEntries(current.entry, e),
        src:
          src === "fs" ||
          (current && current.src !== "fs" && src === "fs")
            ? "fs"
            : current.src,
      };
      continue;
    }
    merged.push({ entry: e, src: src });
  }
  return merged.map(function (x) {
    return x.entry;
  });
}

function refreshPortalHistoryFromFirestore(opId) {
  const id = String(opId || "").trim();
  if (!db) {
    maybeRenderPortalRequestHistory();
    return;
  }
  if (!id) {
    maybeRenderPortalRequestHistory();
    return;
  }
  whenFirebaseAuthReady()
    .then(function () {
      if (!db) return;
      return db
        .collection("solicitudes")
        .where("operatorId", "==", id)
        .get();
    })
    .then(function (qs) {
      if (!qs || !qs.docs) return;
      window.__firestoreHistorialByOperator[id] = qs.docs.map(
        firestoreDocToHistoryEntry
      );
      maybeRenderPortalRequestHistory();
    })
    .catch(function (err) {
      console.warn("[Firestore] historial portal:", err);
      maybeRenderPortalRequestHistory();
    });
}

function getAdminHistorialFirestoreMode() {
  const r = document.querySelector(
    'input[name="adminHistorialFsScope"]:checked'
  );
  if (r && r.value === "all") return "all";
  return "operator";
}

function setupAdminHistorialFirestoreScopeControls() {
  const wrap = document.getElementById("adminHistorialFsScopeWrap");
  if (!wrap || wrap.dataset.bound === "1") return;
  wrap.dataset.bound = "1";
  wrap.addEventListener("change", function () {
    const content = document.getElementById("adminHistoryContent");
    if (content && content.style.display !== "none") {
      refreshAdminHistorialFromFirestoreAndRender();
    }
  });
}

function refreshAdminHistorialFromFirestoreAndRender() {
  const list = document.getElementById("adminHistoryList");
  if (!list) return;

  const mode = getAdminHistorialFirestoreMode();
  if (mode === "all") {
    if (!db) {
      window.__firestoreHistorialAll = [];
      renderAdminRequestHistoryUnified();
      return;
    }
    whenFirebaseAuthReady()
      .then(function () {
        if (!db) return;
        return db
          .collection("solicitudes")
          .orderBy("createdAt", "desc")
          .limit(FIRESTORE_SOLICITUDES_LIMIT_ALL)
          .get();
      })
      .then(function (qs) {
        if (qs && qs.docs) {
          window.__firestoreHistorialAll = qs.docs.map(firestoreDocToHistoryEntry);
        }
        renderAdminRequestHistoryUnified();
      })
      .catch(function (err) {
        console.warn("[Firestore] historial admin (todos):", err);
        renderAdminRequestHistoryUnified();
      });
    return;
  }

  const opId =
    state.filtered && state.filtered.length === 1 && state.filtered[0].id
      ? String(state.filtered[0].id)
      : "";
  if (!opId) {
    renderAdminRequestHistoryUnified();
    return;
  }
  if (!db) {
    renderAdminRequestHistoryUnified();
    return;
  }
  whenFirebaseAuthReady()
    .then(function () {
      if (!db) return;
      return db
        .collection("solicitudes")
        .where("operatorId", "==", opId)
        .get();
    })
    .then(function (qs) {
      if (qs && qs.docs) {
        window.__firestoreHistorialByOperator[opId] = qs.docs.map(
          firestoreDocToHistoryEntry
        );
      }
      renderAdminRequestHistoryUnified();
    })
    .catch(function (err) {
      console.warn("[Firestore] historial admin (operador):", err);
      renderAdminRequestHistoryUnified();
    });
}

/**
 * maestroop/admin util: borra en Firestore solo la colección `solicitudes` del operador.
 * No toca `operatorVacationSaldo` (saldo de días consumidos); son datos independientes.
 * @returns {Promise<{deletedCount: number, skipped: boolean}>}
 */
function deleteSolicitudesFromFirestoreByOperator(opId) {
  const id = String(opId || "").trim();
  if (!id || !db) {
    return Promise.resolve({ deletedCount: 0, skipped: true });
  }
  return whenFirebaseAuthReady()
    .then(function () {
      if (!db) return null;
      return db
        .collection("solicitudes")
        .where("operatorId", "==", id)
        .get();
    })
    .then(function (qs) {
      if (qs === null) {
        return { deletedCount: 0, skipped: true };
      }
      if (!qs || !qs.docs || !qs.docs.length) {
        return { deletedCount: 0, skipped: false };
      }
      const docs = qs.docs.slice();
      let deletedCount = 0;
      let chain = Promise.resolve();
      while (docs.length) {
        const chunk = docs.splice(0, 400);
        chain = chain.then(function () {
          const batch = db.batch();
          chunk.forEach(function (docSnap) {
            batch.delete(docSnap.ref);
          });
          return batch.commit().then(function () {
            deletedCount += chunk.length;
          });
        });
      }
      return chain.then(function () {
        try {
          if (window.__firestoreHistorialByOperator) {
            delete window.__firestoreHistorialByOperator[id];
          }
          if (Array.isArray(window.__firestoreHistorialAll)) {
            window.__firestoreHistorialAll = window.__firestoreHistorialAll.filter(
              function (entry) {
                return (
                  String(entry && entry.operatorId != null ? entry.operatorId : "") !==
                  id
                );
              }
            );
          }
        } catch (e) {
          /* ignore */
        }
        return { deletedCount: deletedCount, skipped: false };
      });
    });
}

function renderAdminRequestHistoryUnified() {
  const list = document.getElementById("adminHistoryList");
  if (!list) return;

  const mode = getAdminHistorialFirestoreMode();
  if (mode === "all") {
    const entries = window.__firestoreHistorialAll || [];
    const sorted = entries.slice().sort(function (a, b) {
      return (b && b.ts ? b.ts : 0) - (a && a.ts ? a.ts : 0);
    });
    const html = buildAdminRequestHistoryItemsFromEntries(sorted, {
      defaultOpId: "",
      omitPdfButton: false,
      forceOperatorFooter: true,
    });
    list.innerHTML =
      html ||
      "<p style='margin:0;color:#000000;'>No hay solicitudes en Firestore (revisa permisos o el índice de <code>createdAt</code>).</p>";
    return;
  }

  const opId =
    state.filtered && state.filtered.length === 1 && state.filtered[0].id
      ? String(state.filtered[0].id)
      : "";
  if (!opId) {
    list.innerHTML = "";
    return;
  }
  renderAdminRequestHistory(opId);
}

// Configuración básica
const MOTIVOS = [
  "Vacaciones",
  "Permiso con goce",
  "Falta justificada",
  "Permiso sin goce"
];
const DIAS_VACACIONALES_BASE = 20;

/**
 * Escala html2canvas al generar PDF. Más alto = más nitidez pero más lento (todo corre en el
 * mismo hilo del navegador: pintar HTML → canvas → codificar imagen → armar PDF).
 * 3 suele ser buen equilibrio; sube a 4 solo si necesitas más detalle.
 */
const PDF_HTML2CANVAS_SCALE = 3;

/**
 * Pantalla de carga al generar PDF (velo).
 * 1 = Diseño 1: texto centrado sobre fondo blanco.
 * 2 = Diseño 2: tarjeta con franja lateral, fila spinner + textos.
 * 3 = Diseño 3: tarjeta clara, franja superior, puntos pulsantes y fondo radial.
 * 4 = Diseño 4: estética del proyecto (.card #31305a, radio 18px, acento verde, scrim oscuro).
 * 5 = Diseño 5: panel tipo login-card (azul translúcido), icono documento y velo radial claro.
 * 6 = Diseño 6: tarjeta tipo historial admin (franja #0f172a, cabecera tabla, pie gris).
 * 7 = Diseño 7: semi-formal (membrete, doble filete, título en serif, tonos neutros).
 * 8 = Diseño 8: gradiente vibrante + orbes difuminados + panel cristal (glassmorphism).
 * 9 = Diseño 9: neo-brutalista (amarillo, borde negro grueso, sombra dura, tipografía pesada).
 * 10 = Diseño 10: formal institucional (cabecera azul marino, filete dorado vertical, aviso administrativo).
 * 11 = Diseño 11: estilo foto instantánea (Polaroid, marco blanco, área oscura, leve inclinación).
 * 12 = Diseño 12: ticket / recibo térmico (columna estrecha, monoespaciado, líneas guión).
 * 13 = Diseño 13: hoja inferior (bottom sheet), asa de arrastre, velo degradado.
 * 14 = Diseño 14: conversación tipo chat (avatar + burbuja, puntos “escribiendo…”).
 * 15 = Diseño 15: claqueta de cine (rayas, “escena / toma”, fondo oscuro tipo plató).
 */
const PDF_LOADING_VEIL_DESIGN = 1;

function vacationDaysConsumedStorageKey(opId) {
  if (!opId) return "";
  return "vacaciones_operador_vacaciones_consumidas_" + String(opId).trim();
}

function vacationDaysConsumedLastAppliedTokenKey(opId) {
  if (!opId) return "";
  return "vacaciones_operador_vacaciones_consumidas_token_" + String(opId).trim();
}

function vacationSaldoFirestoreDoc(opId) {
  if (!db) return null;
  const id = String(opId || "").trim();
  if (!id) return null;
  return db.collection("operatorVacationSaldo").doc(id);
}

function firebaseErrorBrief(err) {
  if (!err) return "unknown";
  const code = err.code != null ? String(err.code) : "";
  const msg = err.message != null ? String(err.message) : String(err);
  return code ? code + ": " + msg : msg;
}

/** Reescribe en Firestore el consumo local actual (no borra solicitudes). */
function syncVacationSaldoFromLocalToFirestore(opId) {
  return syncVacationDaysConsumedToFirestore(opId, getVacationDaysConsumed(opId));
}

function syncVacationDaysConsumedToFirestore(opId, consumedDays) {
  const n = parseInt(String(consumedDays || "0"), 10);
  const safe = Number.isFinite(n) && n > 0 ? n : 0;
  return whenFirebaseAuthReady()
    .then(function () {
      const ref = vacationSaldoFirestoreDoc(opId);
      if (!ref) return Promise.resolve(false);
      return ref
        .set(
          {
            operatorId: String(opId).trim(),
            consumedDays: safe,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        )
        .then(function () {
          return true;
        });
    })
    .catch(function (err) {
      console.warn("[Firestore] no se pudo sincronizar saldo vacaciones:", err);
      return false;
    });
}

function solicitudFirestoreIsApprovedStatus(statusRaw) {
  const s = String(statusRaw != null ? statusRaw : "")
    .trim()
    .toLowerCase();
  return s === "aprobado" || s === "autorizado";
}

function sumConsumedDaysFromSolicitudesQuerySnapshot(qs) {
  if (!qs || qs.empty) return 0;
  let total = 0;
  qs.forEach(function (docSnap) {
    const d = docSnap && typeof docSnap.data === "function" ? docSnap.data() : {};
    const status = d && d.status != null ? d.status : "";
    if (!solicitudFirestoreIsApprovedStatus(status)) return;
    const motive = String(
      d && d.motive != null
        ? d.motive
        : d && d.payload && d.payload.motive != null
        ? d.payload.motive
        : ""
    ).trim();
    if (!PORTAL_MOTIVOS_CONSUMEN_SALDO_VACACIONES.includes(motive)) return;
    const values =
      d && d.values && typeof d.values === "object"
        ? d.values
        : d && d.payload && d.payload.values && typeof d.payload.values === "object"
        ? d.payload.values
        : {};
    total += getPortalDiasNoDiasFromPayloadValues(motive, values);
  });
  return total > 0 ? total : 0;
}

/**
 * Recupera consumo desde historial Firestore cuando falta operatorVacationSaldo.
 * Prueba operatorId como string y como número (datos antiguos).
 */
function estimateVacationConsumedFromSolicitudesFirestoreDetailed(opId) {
  const idStr = String(opId || "").trim();
  const idNum = parseInt(idStr, 10);
  if (!idStr || !db) {
    return Promise.resolve({ total: 0, error: null, docCount: 0, query: "skip" });
  }
  return whenFirebaseAuthReady()
    .then(function () {
      if (!db) return null;
      return db
        .collection("solicitudes")
        .where("operatorId", "==", idStr)
        .get();
    })
    .then(function (qs) {
      if (qs === null) {
        return { total: 0, error: null, docCount: 0, query: "skip" };
      }
      if (qs && !qs.empty) {
        const total = sumConsumedDaysFromSolicitudesQuerySnapshot(qs);
        return {
          total,
          error: null,
          docCount: qs.size,
          query: "string",
        };
      }
      if (Number.isFinite(idNum) && String(idNum) === idStr) {
        return db
          .collection("solicitudes")
          .where("operatorId", "==", idNum)
          .get()
          .then(function (qs2) {
            const total2 = sumConsumedDaysFromSolicitudesQuerySnapshot(qs2);
            return {
              total: total2,
              error: null,
              docCount: qs2 ? qs2.size : 0,
              query: "number",
            };
          })
          .catch(function (err) {
            return {
              total: 0,
              error: firebaseErrorBrief(err),
              docCount: 0,
              query: "number_query_fail",
            };
          });
      }
      return { total: 0, error: null, docCount: 0, query: "string_empty" };
    })
    .catch(function (err) {
      console.warn("[Firestore] estimar consumo desde solicitudes:", err);
      return {
        total: 0,
        error: firebaseErrorBrief(err),
        docCount: 0,
        query: "error",
      };
    });
}

function estimateVacationConsumedDaysFromSolicitudesFirestore(opId) {
  return estimateVacationConsumedFromSolicitudesFirestoreDetailed(opId).then(function (r) {
    return r && Number.isFinite(r.total) ? r.total : 0;
  });
}

/**
 * Alinea el consumo local con `operatorVacationSaldo` en Firestore.
 * Regla clave: nunca subir días por falta de doc remoto.
 * - Si no existe doc y hay consumo local (>0), se crea en Firestore desde local.
 * - Si no existe doc y local=0, se intenta recuperar desde solicitudes aprobadas en Firestore.
 * - Si no existe doc y local=0, no se fuerza nada (queda base local).
 * - Si existe doc, el valor remoto manda.
 */
function reconcileVacationDaysConsumedWithFirestore(opId) {
  const id = String(opId || "").trim();
  if (!id || !db) return Promise.resolve(false);
  const key = vacationDaysConsumedStorageKey(id);
  if (!vacationSaldoFirestoreDoc(id)) return Promise.resolve(false);

  return whenFirebaseAuthReady()
    .then(function () {
      const ref = vacationSaldoFirestoreDoc(id);
      if (!ref) return false;
      return ref.get();
    })
    .then(function (snap) {
      if (snap === false) return false;
      const prev = getVacationDaysConsumed(id);

      if (!snap || !snap.exists) {
        // No existe respaldo remoto:
        // - Si local ya tiene consumo, persistir ese valor en Firestore (no resetear a base).
        if (prev > 0) {
          return syncVacationDaysConsumedToFirestore(id, prev).then(function () {
            return false;
          });
        }
        // - Si local es 0, intentar reconstruirlo desde solicitudes aprobadas históricas.
        return estimateVacationConsumedDaysFromSolicitudesFirestore(id).then(function (estimated) {
          const recovered = Number.isFinite(estimated) && estimated > 0 ? estimated : 0;
          if (recovered <= 0) return false;
          try {
            window.localStorage.setItem(key, String(recovered));
          } catch (e) {
            /* ignore */
          }
          try {
            window.localStorage.setItem(
              vacationSaldoNudgeStorageKey(id),
              String(Date.now())
            );
          } catch (e) {
            /* ignore */
          }
          return syncVacationDaysConsumedToFirestore(id, recovered).then(function () {
            return true;
          });
        });
      }

      const data = snap.data() || {};
      const n = parseInt(
        String(data.consumedDays != null ? data.consumedDays : "0"),
        10
      );
      const remote = Number.isFinite(n) && n > 0 ? n : 0;

      if (remote === 0) {
        return estimateVacationConsumedDaysFromSolicitudesFirestore(id).then(function (estimated) {
          const recovered = Number.isFinite(estimated) && estimated > 0 ? estimated : 0;
          if (recovered <= 0) {
            if (prev === 0) return false;
            try {
              window.localStorage.removeItem(key);
            } catch (e) {
              /* ignore */
            }
            return true;
          }
          if (recovered === prev) return false;
          try {
            window.localStorage.setItem(key, String(recovered));
          } catch (e) {
            /* ignore */
          }
          try {
            window.localStorage.setItem(
              vacationSaldoNudgeStorageKey(id),
              String(Date.now())
            );
          } catch (e) {
            /* ignore */
          }
          return syncVacationDaysConsumedToFirestore(id, recovered).then(function () {
            return true;
          });
        });
      }

      if (remote === prev) return false;
      try {
        window.localStorage.setItem(key, String(remote));
      } catch (e) {
        /* ignore */
      }
      try {
        window.localStorage.setItem(
          vacationSaldoNudgeStorageKey(id),
          String(Date.now())
        );
      } catch (e) {
        /* ignore */
      }
      return true;
    })
    .catch(function (err) {
      console.warn("[Firestore] reconciliar saldo vacaciones:", err);
      return false;
    });
}

function runPortalVacationSaldoFirestoreReconcile(oid) {
  const id = String(oid || "").trim();
  if (!id) return Promise.resolve(false);
  return reconcileVacationDaysConsumedWithFirestore(id).then(function (changed) {
    if (changed) portalRefreshLocalVacationSaldoUIForOperator(id);
    return changed;
  });
}

/**
 * Pre-hidratación al iniciar sesión local:
 * deja el consumo en localStorage antes de entrar a portal.html.
 */
function hydrateVacationConsumedFromFirestoreForLogin(opId) {
  const id = String(opId || "").trim();
  if (!id || !db) return Promise.resolve(false);
  const key = vacationDaysConsumedStorageKey(id);
  if (!vacationSaldoFirestoreDoc(id)) return Promise.resolve(false);
  return whenFirebaseAuthReady()
    .then(function () {
      const ref = vacationSaldoFirestoreDoc(id);
      if (!ref) return false;
      return ref.get();
    })
    .then(function (snap) {
      if (snap === false) return false;
      if (snap && snap.exists) {
        const d = snap.data() || {};
        const n = parseInt(
          String(d.consumedDays != null ? d.consumedDays : "0"),
          10
        );
        const remote = Number.isFinite(n) && n > 0 ? n : 0;
        if (remote > 0) {
          window.localStorage.setItem(key, String(remote));
          return true;
        }
        return estimateVacationConsumedDaysFromSolicitudesFirestore(id).then(function (estimated) {
          const recovered = Number.isFinite(estimated) && estimated > 0 ? estimated : 0;
          if (recovered > 0) {
            window.localStorage.setItem(key, String(recovered));
            return syncVacationDaysConsumedToFirestore(id, recovered).then(function () {
              return true;
            });
          }
          window.localStorage.removeItem(key);
          return true;
        });
      }
      return estimateVacationConsumedDaysFromSolicitudesFirestore(id).then(function (estimated) {
        const recovered = Number.isFinite(estimated) && estimated > 0 ? estimated : 0;
        if (recovered > 0) {
          window.localStorage.setItem(key, String(recovered));
          return syncVacationDaysConsumedToFirestore(id, recovered).then(function () {
            return true;
          });
        }
        window.localStorage.removeItem(key);
        return false;
      });
    })
    .catch(function (err) {
      console.warn("[Firestore] hydrate saldo en login:", err);
      return false;
    });
}

function renderVacationSaldoDebugInfoIntoHost(opId, host, boxId) {
  const id = String(opId || "").trim();
  if (!id || !host) return Promise.resolve();
  const debugId = String(boxId || "").trim() || "vacationSaldoDebugBox";
  let box = document.getElementById(debugId);
  if (!box) {
    box = document.createElement("div");
    box.id = debugId;
    box.style.marginTop = "10px";
    box.style.padding = "10px 12px";
    box.style.border = "1px dashed #f59e0b";
    box.style.borderRadius = "8px";
    box.style.background = "#fffbeb";
    box.style.color = "#111827";
    box.style.fontSize = "0.86rem";
    box.style.lineHeight = "1.45";
    host.appendChild(box);
  }

  const firebaseStatus = String(window.__firebaseStatus || "unknown");
  const localConsumed = getVacationDaysConsumed(id);
  box.textContent =
    "DEBUG SALDO (temporal) | operador " +
    id +
    " | firebaseStatus=" +
    firebaseStatus +
    " | localConsumed=" +
    String(localConsumed) +
    " | operatorVacationSaldo.consumedDays=consultando... | reconstructedFromSolicitudes=consultando...";

  if (!db) return Promise.resolve();

  const remotePromise = whenFirebaseAuthReady().then(function () {
    const ref = vacationSaldoFirestoreDoc(id);
    if (!ref) return "ref_null";
    return ref
      .get()
      .then(function (snap) {
        if (!snap || !snap.exists) return "no_doc";
        const d = snap.data() || {};
        const n = parseInt(
          String(d.consumedDays != null ? d.consumedDays : "0"),
          10
        );
        return Number.isFinite(n) && n > 0 ? String(n) : "0";
      })
      .catch(function (err) {
        return "READ_FAIL: " + firebaseErrorBrief(err);
      });
  });

  const reconstructedPromise = estimateVacationConsumedFromSolicitudesFirestoreDetailed(id);

  return Promise.all([remotePromise, reconstructedPromise]).then(function (vals) {
    const remoteConsumed = vals[0];
    const rec = vals[1] || {};
    const recTotal = Number.isFinite(rec.total) ? rec.total : 0;
    const recPart =
      "total=" +
      String(recTotal) +
      (rec.query ? " | query=" + String(rec.query) : "") +
      (rec.docCount != null ? " | solicitudesMatched=" + String(rec.docCount) : "") +
      (rec.error ? " | solicitudesErr=" + String(rec.error) : "");
    box.textContent =
      "DEBUG SALDO (temporal) | operador " +
      id +
      " | firebaseStatus=" +
      firebaseStatus +
      " | auth=" +
      String(window.__firebaseAuthStatus || "pending") +
      " | localConsumed=" +
      String(getVacationDaysConsumed(id)) +
      " | operatorVacationSaldo.consumedDays=" +
      remoteConsumed +
      " | reconstructedFromSolicitudes=" +
      recPart;
  });
}

/**
 * Portal: debug desactivado en UI final (se conserva helper por soporte).
 */
function renderPortalVacationSaldoDebugInfo() {
  const box = document.getElementById("portalVacationSaldoDebugBox");
  if (box && box.parentNode) {
    box.parentNode.removeChild(box);
  }
  return Promise.resolve();
}

/**
 * Maestroop: muestra debug de saldo para el operador seleccionado.
 */
function renderMaestroVacationSaldoDebugInfo(opId) {
  const maestroRoot = document.getElementById("maestroOpRoot");
  if (!maestroRoot) return Promise.resolve();
  const isAuth = window.sessionStorage.getItem("vacaciones_auth");
  const role = window.sessionStorage.getItem("vacaciones_role");
  if (isAuth !== "true" || role !== "maestroop") return Promise.resolve();
  const host = document.getElementById("maestroOperatorCard");
  return renderVacationSaldoDebugInfoIntoHost(opId, host, "maestroVacationSaldoDebugBox");
}

/**
 * Sincronización en vivo del saldo desde Firestore (sobrevive a borrar cookies/localStorage).
 * onSnapshot entrega el estado inicial y cambios posteriores del documento.
 */
function startPortalVacationSaldoFirestoreLiveSync(opId) {
  const id = String(opId || "").trim();
  if (!id || !db) return;
  if (window.__portalVacationSaldoLiveSyncOpId === id) return;
  if (window.__portalVacationSaldoLiveSyncAttachPending === id) return;
  window.__portalVacationSaldoLiveSyncAttachPending = id;
  whenFirebaseAuthReady().then(function () {
    if (window.__portalVacationSaldoLiveSyncAttachPending !== id) return;
    window.__portalVacationSaldoLiveSyncAttachPending = null;
    const liveId = (window.sessionStorage.getItem("vacaciones_operator_id") || "").trim();
    if (liveId !== id) return;
    if (window.__portalVacationSaldoLiveSyncOpId === id) return;
    try {
      if (typeof window.__portalVacationSaldoLiveSyncUnsub === "function") {
        window.__portalVacationSaldoLiveSyncUnsub();
      }
    } catch (e) {
      /* ignore */
    }
    const ref = vacationSaldoFirestoreDoc(id);
    if (!ref || typeof ref.onSnapshot !== "function") return;
    window.__portalVacationSaldoLiveSyncOpId = id;
    window.__portalVacationSaldoLiveSyncUnsub = ref.onSnapshot(
      function (snap) {
        if (!snap || !snap.exists) return;
        const data = snap.data() || {};
        const n = parseInt(
          String(data.consumedDays != null ? data.consumedDays : "0"),
          10
        );
        const remote = Number.isFinite(n) && n > 0 ? n : 0;
        const prev = getVacationDaysConsumed(id);
        if (remote === prev) return;
        const key = vacationDaysConsumedStorageKey(id);
        if (remote === 0) {
          window.localStorage.removeItem(key);
        } else {
          window.localStorage.setItem(key, String(remote));
        }
        try {
          window.localStorage.setItem(vacationSaldoNudgeStorageKey(id), String(Date.now()));
        } catch (e) {
          /* ignore */
        }
        portalRefreshLocalVacationSaldoUIForOperator(id);
      },
      function (err) {
        console.warn("[Firestore] live sync saldo vacaciones:", err);
      }
    );
  });
}

/** Cambia en cada reset de saldo para disparar `storage` / sondeo aunque el consumo ya fuera 0. */
function vacationSaldoNudgeStorageKey(opId) {
  if (!opId) return "";
  return "vacaciones_saldo_nudge_" + String(opId).trim();
}

/** Días de vacaciones ya descontados del tope (tras cierre aprobado de solicitud con campo No. días). */
function getVacationDaysConsumed(opId) {
  if (!opId) return 0;
  const raw = window.localStorage.getItem(vacationDaysConsumedStorageKey(opId));
  const n = parseInt(String(raw || "0"), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Maestro / utilidades: devuelve al operador el tope completo (20).
 * Los días gastados acumulados pasan a 0; notifica al portal para actualizar "días disponibles".
 * @returns {Promise<boolean>}
 */
function clearVacationDaysConsumedStorageForOperator(opId) {
  if (!opId) return Promise.resolve(false);
  const id = String(opId).trim();
  const key = vacationDaysConsumedStorageKey(id);
  if (!key) return Promise.resolve(false);
  try {
    window.localStorage.removeItem(key);
  } catch (e) {
    /* ignore */
  }
  try {
    const tk = vacationDaysConsumedLastAppliedTokenKey(id);
    if (tk) window.localStorage.removeItem(tk);
  } catch (e) {
    /* ignore */
  }
  try {
    window.localStorage.setItem(vacationSaldoNudgeStorageKey(id), String(Date.now()));
  } catch (e) {
    /* ignore */
  }
  broadcastVacationSaldoReset(id);
  return syncVacationDaysConsumedToFirestore(id, 0);
}

/** Saldo restante en portal: 20 menos días ya consumidos (tras cierres aprobados con No. días). */
function getPortalVacationSaldoRestante(opId) {
  if (!opId) return DIAS_VACACIONALES_BASE;
  const consumed = getVacationDaysConsumed(opId);
  return Math.max(0, DIAS_VACACIONALES_BASE - consumed);
}

/** Motivos cuyo campo No. días descuenta del tope de vacaciones (misma lógica que Vacaciones). */
const PORTAL_MOTIVOS_CONSUMEN_SALDO_VACACIONES = [
  "Vacaciones",
  "Permiso con goce",
  "Falta justificada",
  "Permiso sin goce"
];

/**
 * Lee días del payload guardado según el motivo (ids del formulario portal).
 * @param {string} motive
 * @param {Record<string, string>} values
 * @returns {number}
 */
function getPortalDiasNoDiasFromPayloadValues(motive, values) {
  if (!values || typeof values !== "object") return 0;
  const m = String(motive || "").trim();
  const idByMotive = {
    Vacaciones: "diasSolicitadosInput",
    "Permiso con goce": "diasSolicitadosPermisoGoceInput",
    "Falta justificada": "diasSolicitadosFaltaJustificadaInput",
    "Permiso sin goce": "diasSolicitadosPermisoSinGoceInput"
  };
  const fieldId = idByMotive[m];
  if (!fieldId) return 0;
  const d = parseInt(String(values[fieldId] || "").trim(), 10);
  return Number.isFinite(d) && d > 0 ? d : 0;
}

/**
 * Saldo que debe ver el empleado en mensajes: el persistido menos días de una solicitud ya aprobada
 * (con No. días) que aún no se sumaron al consumo (hasta «Generar nueva solicitud»).
 */
function getPortalVacationSaldoMostradoAlEmpleado(opId) {
  if (!opId) return DIAS_VACACIONALES_BASE;
  const id = String(opId).trim();
  const base = getPortalVacationSaldoRestante(id);
  const s = withComputedEstatusFinal(getPermisoStatus(id));
  if (normalizePermisoRowValue(s.estatusFinal) !== "aprobado") return base;
  const payload = getLastSavedPayloadFromOperator(id);
  if (!payload) return base;
  const motive = String(payload.motive || "").trim();
  if (!PORTAL_MOTIVOS_CONSUMEN_SALDO_VACACIONES.includes(motive)) return base;
  const vals =
    payload.values && typeof payload.values === "object" ? payload.values : {};
  const d = getPortalDiasNoDiasFromPayloadValues(motive, vals);
  if (d < 1) return base;
  return Math.max(0, base - d);
}

// Credenciales de acceso (pantalla de login)
// - Maestro: usuario principal (Samsong1234).
// - Administradores: 3 usuarios con permisos de aprobar/rechazar y ver listado.
// - Usuario local: usuario = ID (1001–1500), contraseña = SAMSONG_LOCAL_<ID> (ej. SAMSONG_LOCAL_1001).
const MASTER_USER = "Samsong1234";
const MASTER_PASSWORD = "SAMSONG_HARV_2026";

const ADMIN_CREDENTIALS = [
  { user: "DeptManag2026", password: "SAMSONG_ADMIN1_2026" },
  { user: "Supervisor2026", password: "SAMSONG_ADMIN2_2026" },
  { user: "LuisHHRR2026", password: "SAMSONG_ADMIN3_2026" }
];

/** Perfil del admin que inició sesión (para Aceptar/Rechazar en admin.html) */
const ADMIN_PROFILE_BY_USER = {
  Supervisor2026: "supervisor",
  DeptManag2026: "gerente",
  LuisHHRR2026: "rh"
};

function permisoStatusStorageKey(operatorId) {
  return `vacaciones_permiso_status_${operatorId}`;
}

/** Solo en admin.html: recuadro de solicitud guardada + estatus del permiso. */
function isAdminHtmlPage() {
  return !!document.getElementById("adminSavedEstatusWrap");
}

/** Solo en portal.html (usuario local). */
function isPortalHtmlPage() {
  return !!document.getElementById("portalHistoryList");
}

function portalFinalDecisionModalAckKey(opId) {
  return `vacaciones_portal_final_modal_ack_${String(opId)}`;
}

function clearPortalFinalDecisionModalAck(opId) {
  if (!opId) return;
  window.localStorage.removeItem(portalFinalDecisionModalAckKey(opId));
}

/** Bloqueo persistente de Aceptar/Rechazar en admin tras una decisión (sobrevive al F5). */
function adminSavedDecisionLockStorageKey(opId) {
  return `vacaciones_admin_saved_decision_lock_${opId}`;
}

function clearAdminSavedDecisionLocked(opId) {
  if (!opId) return;
  window.localStorage.removeItem(adminSavedDecisionLockStorageKey(String(opId)));
}

/**
 * admin: sesión "Modif. Estado" en curso (misma pestaña).
 * sessionStorage sobrevive al F5; al cargar/refrescar admin.html se limpia con
 * resetAdminEphemeralPermisoActionUiLocks() para volver al estado persistido del permiso.
 */
function adminModifEstadoSessionKey(opId) {
  return `vacaciones_admin_modif_estado_session_${opId}`;
}

function setAdminModifEstadoSession(opId) {
  if (!opId) return;
  window.sessionStorage.setItem(adminModifEstadoSessionKey(String(opId)), "1");
}

function clearAdminModifEstadoSession(opId) {
  if (!opId) return;
  window.sessionStorage.removeItem(adminModifEstadoSessionKey(String(opId)));
}

function hasAdminModifEstadoSession(opId) {
  if (!opId) return false;
  return (
    window.sessionStorage.getItem(adminModifEstadoSessionKey(String(opId))) ===
    "1"
  );
}

/** admin: historial de solicitudes guardadas por operador (vacaciones/permiso/falta). */
function adminRequestHistoryStorageKey(opId) {
  return `vacaciones_admin_request_history_${opId}`;
}

/** Portal (Modificar cambios): el operador está editando; admin no debe usar Modif./Borrar estado. */
function portalModificarCambiosActiveStorageKey(opId) {
  return `vacaciones_portal_modificar_cambios_active_${opId}`;
}

function setPortalModificarCambiosActiveForAdminLock(opId) {
  if (!opId) return;
  window.localStorage.setItem(
    portalModificarCambiosActiveStorageKey(String(opId)),
    "1"
  );
}

function clearPortalModificarCambiosActiveForAdminLock(opId) {
  if (!opId) return;
  window.localStorage.removeItem(portalModificarCambiosActiveStorageKey(String(opId)));
}

function operatorPhotoStorageKey(opId) {
  return `vacaciones_operator_photo_${String(opId)}`;
}

function getCurrentOperatorIdForPhoto() {
  if (state.filtered && state.filtered.length === 1 && state.filtered[0].id) {
    return String(state.filtered[0].id);
  }
  const fromSession = (window.sessionStorage.getItem("vacaciones_operator_id") || "").trim();
  return fromSession || "";
}

function renderOperatorPhotoFromStorage(operatorId) {
  const photoImg = document.getElementById("operatorPhoto");
  const photoWrap = document.getElementById("operatorPhotoWrap");
  if (!photoImg || !photoWrap || !operatorId) return;
  const placeholder = photoWrap.querySelector(".operator-photo-placeholder");
  const savedDataUrl = window.localStorage.getItem(operatorPhotoStorageKey(operatorId)) || "";
  if (savedDataUrl) {
    photoImg.setAttribute("src", savedDataUrl);
    photoImg.src = savedDataUrl;
    photoImg.style.display = "block";
    if (placeholder) placeholder.style.display = "none";
    return;
  }
  photoImg.setAttribute("src", "");
  photoImg.src = "";
  photoImg.style.display = "";
  if (placeholder) placeholder.style.display = "flex";
}

function hasPortalModificarCambiosActiveForAdminLock(opId) {
  if (!opId) return false;
  return (
    window.localStorage.getItem(
      portalModificarCambiosActiveStorageKey(String(opId))
    ) === "1"
  );
}

/**
 * Cada carga de admin.html: quita bloqueos efímeros (Modif. Estado en sessionStorage
 * y señal del portal "Modif. Cambios" en localStorage) para que Aceptar/Rechazar
 * y Modif./Borrar reflejen solo el permiso guardado.
 */
function resetAdminEphemeralPermisoActionUiLocks() {
  try {
    const ssKeys = [];
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const k = window.sessionStorage.key(i);
      if (k && k.startsWith("vacaciones_admin_modif_estado_session_")) {
        ssKeys.push(k);
      }
    }
    ssKeys.forEach((k) => window.sessionStorage.removeItem(k));
  } catch (e) {
    /* ignore */
  }
  try {
    const lsKeys = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith("vacaciones_portal_modificar_cambios_active_")) {
        lsKeys.push(k);
      }
    }
    lsKeys.forEach((k) => window.localStorage.removeItem(k));
  } catch (e) {
    /* ignore */
  }
}

function defaultPermisoStatus() {
  return {
    supervisor: "pendiente",
    gerente: "pendiente",
    rh: "pendiente",
    estatusFinal: "pendiente"
  };
}

/** Compatibilidad con datos guardados como "autorizado" */
function normalizePermisoRowValue(v) {
  if (v === "autorizado") return "aprobado";
  return v;
}

function computeEstatusFinalFromAdminRows(statusObj) {
  const s = statusObj || {};
  const rows = [
    normalizePermisoRowValue(s.supervisor),
    normalizePermisoRowValue(s.gerente),
    normalizePermisoRowValue(s.rh)
  ];
  if (rows.every((v) => v === "aprobado")) return "aprobado";
  if (rows.every((v) => v === "rechazado")) return "rechazado";
  return "pendiente";
}

/** Supervisor, Gerente y RH tienen cada uno aprobado o rechazado (ninguna fila pendiente). */
function permisoAllThreeAdminsDecided(opId) {
  if (!opId) return false;
  const s = withComputedEstatusFinal(getPermisoStatus(opId));
  const decided = function (v) {
    const x = normalizePermisoRowValue(v);
    return x === "aprobado" || x === "rechazado";
  };
  return decided(s.supervisor) && decided(s.gerente) && decided(s.rh);
}

function withComputedEstatusFinal(statusObj) {
  const merged = { ...defaultPermisoStatus(), ...(statusObj || {}) };
  merged.supervisor = normalizePermisoRowValue(merged.supervisor);
  merged.gerente = normalizePermisoRowValue(merged.gerente);
  merged.rh = normalizePermisoRowValue(merged.rh);
  merged.estatusFinal = computeEstatusFinalFromAdminRows(merged);
  return merged;
}

function getPermisoStatus(operatorId) {
  if (!operatorId) return defaultPermisoStatus();
  const raw = window.localStorage.getItem(permisoStatusStorageKey(operatorId));
  if (!raw) return defaultPermisoStatus();
  try {
    const o = JSON.parse(raw);
    return withComputedEstatusFinal(o);
  } catch (e) {
    return defaultPermisoStatus();
  }
}

/** El perfil admin actual ya registró aprobado/rechazado en su fila del permiso. */
function adminProfileHasDecidedPermisoRow(opId, profile) {
  if (!opId || !profile) return false;
  if (profile !== "supervisor" && profile !== "gerente" && profile !== "rh") {
    return false;
  }
  const s = getPermisoStatus(opId);
  const v = normalizePermisoRowValue(s[profile]);
  return v === "aprobado" || v === "rechazado";
}

/** Supervisor, Gerente o RH ya dejó su fila en aprobado/rechazado (portal: ocultar Modificar cambios). */
function operatorHasAnyAdminPermisoDecision(opId) {
  if (!opId) return false;
  const s = getPermisoStatus(opId);
  const keys = ["supervisor", "gerente", "rh"];
  for (let i = 0; i < keys.length; i++) {
    const v = normalizePermisoRowValue(s[keys[i]]);
    if (v === "aprobado" || v === "rechazado") return true;
  }
  return false;
}

/**
 * portal.html: oculta "Modificar cambios" solo si algún admin ya aprobó/rechazó
 * para este operador; en caso contrario lo vuelve a mostrar.
 */
function syncPortalModificarCambiosButtonsVisibility(operatorId) {
  if (isAdminHtmlPage()) return;
  const oid =
    operatorId !== undefined && operatorId !== null
      ? String(operatorId)
      : (window.sessionStorage.getItem("vacaciones_operator_id") || "");
  const hide = !!(oid && operatorHasAnyAdminPermisoDecision(oid));
  document.querySelectorAll(".btn-modif-cambios").forEach(function (btn) {
    btn.style.display = hide ? "none" : "";
  });
}

/**
 * Dónde colocar el recuadro «Solicitud en curso» (tras decisión de un admin).
 * - "columna_motivo": dentro de la columna del motivo (vacaciones / falta / sin goce / con goce).
 * - "tras_estatus": en #portalSolicitudEnCursoSlot, justo debajo de «Estatus del permiso».
 */
const PORTAL_SOLICITUD_EN_CURSO_REGION = "columna_motivo";

/**
 * Dentro de la columna del motivo: "first" = primer hijo (arriba), "last" = último hijo (abajo).
 * Solo aplica si PORTAL_SOLICITUD_EN_CURSO_REGION === "columna_motivo".
 */
const PORTAL_SOLICITUD_EN_CURSO_ORDEN_EN_COLUMNA = {
  Vacaciones: "first",
  "Falta justificada": "first",
  "Permiso sin goce": "first",
  "Permiso con goce": "first",
};

function placePortalRequestCardsHost() {
  const host = document.getElementById("portalRequestCardsHost");
  if (!host) return;

  if (PORTAL_SOLICITUD_EN_CURSO_REGION === "tras_estatus") {
    const slot = document.getElementById("portalSolicitudEnCursoSlot");
    if (slot) {
      slot.appendChild(host);
      return;
    }
  }

  const payload = getLastSavedPayloadFromOperator(
    resolvePortalOperatorScopeId() || ""
  );
  const motivoFromPayload =
    payload && payload.motive ? String(payload.motive) : "";
  const motivoSelect = document.getElementById("motivoSelectLocal");
  const motivo =
    motivoFromPayload ||
    (motivoSelect && motivoSelect.value ? motivoSelect.value : "") ||
    "Vacaciones";
  let col = document.querySelector(".vacaciones-columna");
  if (motivo === "Falta justificada") {
    col = document.getElementById("faltaJustificadaColumna");
  } else if (motivo === "Permiso sin goce") {
    col = document.getElementById("permisoSinGoceColumna");
  } else if (motivo === "Permiso con goce") {
    col = document.querySelector(".permiso-goce-columna");
  }
  if (!col) return;
  const orden =
    PORTAL_SOLICITUD_EN_CURSO_ORDEN_EN_COLUMNA[motivo] || "first";
  if (orden === "last") {
    col.appendChild(host);
  } else {
    col.insertBefore(host, col.firstChild);
  }
}

/**
 * Portal local: mientras la solicitud está en curso (guardada, ningún admin ha aprobado/rechazado),
 * solo aplican locked-mode y los recuadros; no se muestra portalRequestCardsHost (evita desordenar el layout).
 * Cuando cualquier admin aprueba o rechaza: se coloca el host en la columna del motivo, se muestra la tarjeta
 * tipo historial (última solicitud) y portal-final-decision-mode oculta los recuadros bloqueados.
 */
function syncPortalRequestFlowUI(operatorId) {
  if (isAdminHtmlPage()) return;
  const opId =
    operatorId !== undefined && operatorId !== null
      ? String(operatorId)
      : (resolvePortalOperatorScopeId() || "");
  const host = document.getElementById("portalRequestCardsHost");
  const list = document.getElementById("portalHistoryList");
  const inlineWrap = document.getElementById("portalInlineLatestSolicitudWrap");

  if (!opId || !host) {
    document.body.classList.remove("portal-final-decision-mode");
    document.body.classList.remove("portal-final-estatus-rechazado");
    if (list) list.innerHTML = "";
    if (inlineWrap) inlineWrap.innerHTML = "";
    syncPortalVacationSaldoRestanteLine("");
    return;
  }

  renderPortalRequestHistory(opId);

  const algunAdminDecidio = operatorHasAnyAdminPermisoDecision(opId);
  const hasSaved = operatorHasValidSavedRequestInStorage(opId);

  if (algunAdminDecidio && hasSaved) {
    placePortalRequestCardsHost();
    host.style.display = "flex";
    if (inlineWrap) {
      inlineWrap.innerHTML = buildAdminRequestHistoryItemsHtml(opId, {
        onlyLatest: true,
        omitPdfButton: true,
      });
    }
    document.body.classList.add("portal-final-decision-mode");
    const sFlow = withComputedEstatusFinal(getPermisoStatus(opId));
    const finalFlow = normalizePermisoRowValue(sFlow.estatusFinal);
    if (finalFlow === "rechazado") {
      document.body.classList.add("portal-final-estatus-rechazado");
    } else {
      document.body.classList.remove("portal-final-estatus-rechazado");
    }
  } else {
    document.body.classList.remove("portal-final-decision-mode");
    document.body.classList.remove("portal-final-estatus-rechazado");
    host.style.display = "none";
    if (inlineWrap) inlineWrap.innerHTML = "";
  }

  syncPortalVacationSaldoRestanteLine(opId);
}

/** Portal: línea bajo la tarjeta de solicitud; el texto de saldo ya no se muestra (aprobado/rechazado). */
function syncPortalVacationSaldoRestanteLine(opId) {
  const el = document.getElementById("portalVacationSaldoRestanteLine");
  if (!el) return;
  el.style.display = "none";
  el.textContent = "";
}

/** portal.html: historial completo (misma lista que admin), debajo de main. */
function renderPortalRequestHistory(operatorId) {
  const list = document.getElementById("portalHistoryList");
  if (!list) return;
  const opId =
    operatorId !== undefined && operatorId !== null
      ? String(operatorId)
      : (resolvePortalOperatorScopeId() || "");
  if (!opId) {
    list.innerHTML = "";
    return;
  }

  const section = document.getElementById("portalHistorySection");
  const useTableLayout =
    section && section.classList.contains("portal-history-layout--table");
  const useRowsLayout =
    section && section.classList.contains("portal-history-layout--rows");
  const useGridLayout =
    section && section.classList.contains("portal-history-layout--grid");
  const useSplitLayout =
    section &&
    (section.classList.contains("portal-history-layout--design2") ||
      section.classList.contains("portal-history-layout--split"));
  const useLedgerLayout =
    section && section.classList.contains("portal-history-layout--ledger");
  const useThreadLayout =
    section && section.classList.contains("portal-history-layout--thread");
  const usePanelLayout =
    section && section.classList.contains("portal-history-layout--panel");
  const useRailLayout =
    section && section.classList.contains("portal-history-layout--rail");
  const useNoticeLayout =
    section && section.classList.contains("portal-history-layout--notice");
  const useMinimalLayout =
    section && section.classList.contains("portal-history-layout--minimal");
  const useGlassLayout =
    section && section.classList.contains("portal-history-layout--glass");
  const useStudioLayout =
    section && section.classList.contains("portal-history-layout--studio");
  const useColumnsLayout =
    section && section.classList.contains("portal-history-layout--columns");
  const useDossierLayout =
    section && section.classList.contains("portal-history-layout--dossier");
  const useInsetLayout =
    section && section.classList.contains("portal-history-layout--inset");
  const useMintLayout =
    section && section.classList.contains("portal-history-layout--mint");
  const useCatalogLayout =
    section && section.classList.contains("portal-history-layout--catalog");
  const useReceiptLayout =
    section && section.classList.contains("portal-history-layout--receipt");
  const usePolaroidLayout =
    section && section.classList.contains("portal-history-layout--polaroid");
  const useJournalLayout =
    section && section.classList.contains("portal-history-layout--journal");
  const useIosLayout =
    section && section.classList.contains("portal-history-layout--ios");
  const useNightLayout =
    section && section.classList.contains("portal-history-layout--night");
  const useNeoLayout =
    section && section.classList.contains("portal-history-layout--neo");
  const usePastelLayout =
    section && section.classList.contains("portal-history-layout--pastel");
  const useFanLayout =
    section && section.classList.contains("portal-history-layout--fan");
  const useTicketLayout =
    section && section.classList.contains("portal-history-layout--ticket");
  const itemsHtml = useTableLayout
    ? buildPortalRequestHistoryTableHtml(opId)
    : useRowsLayout
      ? buildPortalRequestHistoryRowsHtml(opId)
      : useGridLayout
        ? buildPortalRequestHistoryGridHtml(opId)
        : useSplitLayout
          ? buildPortalRequestHistorySplitHtml(opId)
          : useLedgerLayout
            ? buildPortalRequestHistoryLedgerHtml(opId)
            : useThreadLayout
              ? buildPortalRequestHistoryThreadHtml(opId)
              : usePanelLayout
                ? buildPortalRequestHistoryPanelHtml(opId)
                : useRailLayout
                  ? buildPortalRequestHistoryRailHtml(opId)
                  : useNoticeLayout
                    ? buildPortalRequestHistoryNoticeHtml(opId)
                    : useMinimalLayout
                      ? buildPortalRequestHistoryMinimalHtml(opId)
                      : useGlassLayout
                        ? buildPortalRequestHistoryGlassHtml(opId)
                        : useStudioLayout
                          ? buildPortalRequestHistoryStudioHtml(opId)
                          : useColumnsLayout
                            ? buildPortalRequestHistoryColumnsHtml(opId)
                            : useDossierLayout
                              ? buildPortalRequestHistoryDossierHtml(opId)
                              : useInsetLayout
                                ? buildPortalRequestHistoryInsetHtml(opId)
                                : useMintLayout
                                  ? buildPortalRequestHistoryMintHtml(opId)
                                  : useCatalogLayout
                                    ? buildPortalRequestHistoryCatalogHtml(opId)
                                    : useReceiptLayout
                                      ? buildPortalRequestHistoryReceiptHtml(opId)
                                      : usePolaroidLayout
                                        ? buildPortalRequestHistoryPolaroidHtml(opId)
                                        : useJournalLayout
                                          ? buildPortalRequestHistoryJournalHtml(opId)
                                          : useIosLayout
                                            ? buildPortalRequestHistoryIosHtml(opId)
                                            : useNightLayout
                                              ? buildPortalRequestHistoryNightHtml(opId)
                                              : useNeoLayout
                                                ? buildPortalRequestHistoryNeoHtml(opId)
                                                : usePastelLayout
                                                  ? buildPortalRequestHistoryPastelHtml(opId)
                                                  : useTicketLayout
                                                    ? buildPortalRequestHistoryTicketHtml(opId)
                                                    : useFanLayout
                                                      ? buildPortalRequestHistoryFanHtml(opId)
                                                      : buildAdminRequestHistoryItemsHtml(opId);
  if (!itemsHtml) {
    list.innerHTML =
      "<p style='margin:0;color:#000000;'>No hay solicitudes guardadas en el historial.</p>";
    return;
  }

  list.innerHTML = itemsHtml;
}

function maybeRenderPortalRequestHistory() {
  const content = document.getElementById("portalHistoryContent");
  if (!content) return;
  const isVisible = content.style.display !== "none";
  if (!isVisible) return;
  const opId = (resolvePortalOperatorScopeId() || "").trim();
  if (!opId) {
    const list = document.getElementById("portalHistoryList");
    if (list) list.innerHTML = "";
    return;
  }
  renderPortalRequestHistory(opId);
}

function setupPortalRequestHistoryToggle() {
  const btn = document.getElementById("portalHistoryToggleBtn");
  const content = document.getElementById("portalHistoryContent");
  if (!btn || !content) return;
  if (btn.dataset.bound === "1") return;
  btn.dataset.bound = "1";

  btn.addEventListener("click", function () {
    const isHidden = content.style.display === "none";
    content.style.display = isHidden ? "block" : "none";
    btn.setAttribute("aria-expanded", String(isHidden));
    if (isHidden) {
      const opId = (resolvePortalOperatorScopeId() || "").trim();
      refreshPortalHistoryFromFirestore(opId);
    }
  });
}

const PERMISO_STATUS_BC = "vacaciones_permiso_status_bc";
const VACATION_SALDO_BC = "vacaciones_saldo_vacaciones_bc";

/** Canal reutilizado: crear/cerrar en cada envío puede fallar en algunos navegadores. */
let __permisoStatusBcSender = null;
let __vacationSaldoBcSender = null;

function broadcastVacationSaldoReset(operatorId) {
  try {
    if (typeof BroadcastChannel === "undefined") return;
    if (!__vacationSaldoBcSender) {
      __vacationSaldoBcSender = new BroadcastChannel(VACATION_SALDO_BC);
    }
    __vacationSaldoBcSender.postMessage({ operatorId: String(operatorId) });
  } catch (e) {
    /* ignore */
  }
}

function broadcastPermisoStatusChanged(operatorId) {
  try {
    if (typeof BroadcastChannel === "undefined") return;
    if (!__permisoStatusBcSender) {
      __permisoStatusBcSender = new BroadcastChannel(PERMISO_STATUS_BC);
    }
    __permisoStatusBcSender.postMessage({ operatorId: String(operatorId) });
  } catch (e) {
    /* ignore */
  }
}

/** Evita repintar en polling si no hubo cambio en localStorage */
let __portalPermisoStatusLastJson = "";

function setPermisoStatusField(operatorId, roleKey, value) {
  const s = withComputedEstatusFinal(getPermisoStatus(operatorId));
  s[roleKey] = value;
  s.estatusFinal = computeEstatusFinalFromAdminRows(s);
  window.localStorage.setItem(
    permisoStatusStorageKey(operatorId),
    JSON.stringify(s)
  );
  broadcastPermisoStatusChanged(operatorId);
  syncAdminRequestHistoryEstados(String(operatorId));
  const fin = normalizePermisoRowValue(s.estatusFinal);
  if (fin === "aprobado" || fin === "rechazado") {
    syncOperatorLatestSolicitudFirestoreStatus(String(operatorId), fin);
  }
}

function clearPermisoStatusStorage(operatorId) {
  if (!operatorId) return;
  const id = String(operatorId);
  window.localStorage.removeItem(permisoStatusStorageKey(id));
  clearAdminSavedDecisionLocked(id);
  clearAdminModifEstadoSession(id);
  clearPortalFinalDecisionModalAck(id);
  broadcastPermisoStatusChanged(id);
  syncAdminRequestHistoryEstados(id);
  refreshPortalPermisoStatusUI(id);
  updateEstatusPermisoActionButtonsState();
  if (isAdminHtmlPage()) refreshAdminNotificationList();
}

/** Prioriza sessionStorage: debe coincidir con las claves que usa admin (ID del operador). */
function resolvePortalOperatorScopeId() {
  const fromSession = (
    window.sessionStorage.getItem("vacaciones_operator_id") || ""
  ).trim();
  if (fromSession) return fromSession;
  const fromState = state.currentOperatorId;
  if (fromState != null && String(fromState).trim() !== "") {
    return String(fromState).trim();
  }
  return "";
}

/**
 * Historial guardado bajo `vacaciones_admin_request_history_global` (portal sin ID en sesión)
 * → mismo operador que el borrador migrado, para que admin/maestro vean la misma lista.
 */
function migrateGlobalAdminRequestHistoryToOperatorIfNeeded(opId) {
  if (!opId || String(opId) === "global") return;
  const destKey = adminRequestHistoryStorageKey(String(opId));
  const gKey = adminRequestHistoryStorageKey("global");
  const gRaw = window.localStorage.getItem(gKey);
  if (!gRaw) return;
  let destEmpty = true;
  const destRaw = window.localStorage.getItem(destKey);
  if (destRaw) {
    try {
      const d = JSON.parse(destRaw);
      destEmpty = !Array.isArray(d) || d.length === 0;
    } catch (e) {
      destEmpty = true;
    }
  }
  if (!destEmpty) return;
  try {
    const arr = JSON.parse(gRaw);
    if (!Array.isArray(arr) || !arr.length) return;
  } catch (e) {
    return;
  }
  window.localStorage.setItem(destKey, gRaw);
  window.localStorage.removeItem(gKey);
}

/**
 * Si hubo guardados bajo "global", copiarlos al ID numérico para que admin coincida.
 */
function migrateGlobalSavedPayloadToOperatorIfNeeded(opId) {
  if (!opId || opId === "global") return;
  const modeKey = `vacaciones_last_saved_locked_mode_${opId}`;
  const payloadKey = `vacaciones_last_saved_payload_${opId}`;
  if (
    window.localStorage.getItem(modeKey) === "1" &&
    window.localStorage.getItem(payloadKey)
  ) {
    migrateGlobalAdminRequestHistoryToOperatorIfNeeded(opId);
    return;
  }
  const gMode = window.localStorage.getItem(
    "vacaciones_last_saved_locked_mode_global"
  );
  const gPayload = window.localStorage.getItem(
    "vacaciones_last_saved_payload_global"
  );
  if (gMode !== "1" || !gPayload) return;
  try {
    const payload = JSON.parse(gPayload);
    if (!payload || typeof payload !== "object") return;
  } catch (e) {
    return;
  }
  window.localStorage.setItem(modeKey, "1");
  window.localStorage.setItem(payloadKey, gPayload);
  window.localStorage.removeItem("vacaciones_last_saved_locked_mode_global");
  window.localStorage.removeItem("vacaciones_last_saved_payload_global");
  window.localStorage.removeItem(adminSavedDecisionLockStorageKey("global"));
  clearAdminSavedDecisionLocked(opId);
  clearAdminModifEstadoSession(opId);
  migrateGlobalAdminRequestHistoryToOperatorIfNeeded(opId);
}

function operatorHasValidSavedRequestInStorage(opId) {
  if (!opId) return false;
  migrateGlobalSavedPayloadToOperatorIfNeeded(String(opId));
  const modeKey = `vacaciones_last_saved_locked_mode_${opId}`;
  const payloadKey = `vacaciones_last_saved_payload_${opId}`;
  const mode = window.localStorage.getItem(modeKey);
  const payloadRaw = window.localStorage.getItem(payloadKey);
  if (mode !== "1" || !payloadRaw) return false;
  try {
    const payload = JSON.parse(payloadRaw);
    return !!(payload && typeof payload === "object");
  } catch (e) {
    return false;
  }
}

/**
 * admin.html: sin solicitud guardada se ocultan las dos filas de acciones.
 * Con solicitud y sin decisión del perfil: A/R activos, Modif./Borrar bloqueados.
 * Tras Aceptar en el modal de decisión: A/R bloqueados, Modif./Borrar activos.
 * Tras confirmar "Modif. Estado" (sesión en sessionStorage): A/R otra vez activos,
 * Modif./Borrar bloqueados hasta nueva decisión. Tras "Modif. Cambios" en el portal
 * (localStorage): mismo bloqueo en vivo entre pestañas. Cada carga de admin.html
 * resetea esas señales y vuelve al estado persistido del permiso.
 * Si los 3 admins cerraron la decisión final (aprobado o rechazado unánime),
 * "Modif. Estado" queda bloqueado para no alterar ese resultado.
 */
function syncAdminHtmlSavedRequestActionButtons() {
  if (!isAdminHtmlPage()) return;
  const role =
    state.currentRole || window.sessionStorage.getItem("vacaciones_role");
  if (role !== "admin" && role !== "maestro") return;

  const opId =
    state.filtered && state.filtered.length === 1 && state.filtered[0].id
      ? String(state.filtered[0].id)
      : "";
  const show = !!(opId && operatorHasValidSavedRequestInStorage(opId));
  const profile = window.sessionStorage.getItem("vacaciones_admin_profile");
  const decided = adminProfileHasDecidedPermisoRow(opId, profile);
  const modifSession = hasAdminModifEstadoSession(opId);
  const portalModifActive = hasPortalModificarCambiosActiveForAdminLock(opId);
  const permisoUi = withComputedEstatusFinal(getPermisoStatus(opId));
  const estatusFinalNormalizado = normalizePermisoRowValue(permisoUi.estatusFinal);
  const bloquearModifPorDecisionFinalCerrada =
    show &&
    (estatusFinalNormalizado === "aprobado" ||
      estatusFinalNormalizado === "rechazado");

  const card = document.getElementById("adminSavedRequestCard");
  const savedActionsRow = card
    ? card.querySelector(".admin-saved-request-actions")
    : null;
  const estatusActionsRow = document.querySelector(".estatus-permiso-actions");

  if (savedActionsRow) {
    savedActionsRow.style.display = show ? "" : "none";
  }
  if (estatusActionsRow) {
    estatusActionsRow.style.display = show ? "" : "none";
  }

  const acceptBtn = card
    ? card.querySelector(".admin-saved-action-accept")
    : null;
  const rejectBtn = card
    ? card.querySelector(".admin-saved-action-reject")
    : null;
  const modifBtn = document.querySelector(".estatus-permiso-btn-modif");
  const borrarBtn = document.querySelector(".estatus-permiso-btn-borrar");

  let blockAR = true;
  let enableModifBorrar = false;
  if (show) {
    if (modifSession || portalModifActive) {
      blockAR = false;
      enableModifBorrar = false;
    } else if (profile && decided) {
      blockAR = true;
      enableModifBorrar = true;
    } else {
      blockAR = false;
      enableModifBorrar = false;
    }
  }

  if (acceptBtn) acceptBtn.disabled = !show || blockAR;
  if (rejectBtn) rejectBtn.disabled = !show || blockAR;
  if (modifBtn) {
    modifBtn.disabled =
      !show || !enableModifBorrar || bloquearModifPorDecisionFinalCerrada;
    if (bloquearModifPorDecisionFinalCerrada) {
      modifBtn.setAttribute(
        "title",
        estatusFinalNormalizado === "rechazado"
          ? "No disponible: la solicitud fue rechazada por Supervisor, Gerente y RH."
          : "No disponible: la solicitud fue aprobada por Supervisor, Gerente y RH."
      );
    } else {
      modifBtn.removeAttribute("title");
    }
  }
  if (borrarBtn) borrarBtn.disabled = !show || !enableModifBorrar;

  if (show && opId) {
    syncAdminSavedRequestActionsLayoutForOperatorId(opId);
  } else {
    syncAdminSavedRequestActionsLayout(null);
  }
}

/** Compatibilidad: texto exacto del selector / payload */
const ADMIN_SAVED_MOTIVE_CSS_SUFFIX = {
  Vacaciones: "vacaciones",
  "Permiso con goce": "permiso-con-goce",
  "Falta justificada": "falta-justificada",
  "Permiso sin goce": "permiso-sin-goce",
};

/**
 * Nombre completo de cada variable CSS — una por motivo, sin construir el nombre con plantillas.
 */
const ADMIN_SAVED_CSS_VAR_BY_SUFFIX = {
  vacaciones: "--admin-saved-nudge-y-vacaciones",
  "permiso-con-goce": "--admin-saved-nudge-y-permiso-con-goce",
  "falta-justificada": "--admin-saved-nudge-y-falta-justificada",
  "permiso-sin-goce": "--admin-saved-nudge-y-permiso-sin-goce",
};

/** Respaldos (mismos valores que style.css :root) si falla la lectura */
const ADMIN_SAVED_NUDGE_Y_FALLBACK = {
  vacaciones: "-76px",
  "permiso-con-goce": "-32px",
  "falta-justificada": "-32px",
  "permiso-sin-goce": "-32px",
};

/**
 * Un solo sufijo por motivo; normaliza espacios raros para no caer en otro motivo.
 */
function normalizeMotiveToAdminSavedSuffix(motive) {
  if (motive == null) return "";
  const s = String(motive)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  const lc = s.toLowerCase();
  if (lc === "vacaciones") return "vacaciones";
  if (lc === "permiso con goce") return "permiso-con-goce";
  if (lc === "falta justificada") return "falta-justificada";
  if (lc === "permiso sin goce") return "permiso-sin-goce";
  const legacy = ADMIN_SAVED_MOTIVE_CSS_SUFFIX[s];
  return legacy || "";
}

function readAdminSavedNudgeY(suffix) {
  const varName = ADMIN_SAVED_CSS_VAR_BY_SUFFIX[suffix];
  if (!varName) return "";
  const fb = ADMIN_SAVED_NUDGE_Y_FALLBACK[suffix];
  let v = "";
  try {
    v = document.documentElement.style.getPropertyValue(varName).trim();
    if (!v) {
      v = getComputedStyle(document.documentElement)
        .getPropertyValue(varName)
        .trim();
    }
  } catch (e) {
    /* ignore */
  }
  if (!v && fb) v = fb;
  return v || "";
}

/**
 * Botones anclados con CSS (absolute bottom); solo aplica translateY por motivo.
 */
function syncAdminSavedRequestActionsLayout(motive) {
  const card = document.getElementById("adminSavedRequestCard");
  const row = card && card.querySelector(".admin-saved-request-actions");
  if (!row) return;
  const suffix = normalizeMotiveToAdminSavedSuffix(motive);
  row.style.marginTop = "";
  row.style.top = "";
  row.style.bottom = "";
  row.style.left = "";
  row.style.right = "";
  if (!suffix) {
    row.style.transform = "";
    if (card) card.removeAttribute("data-admin-saved-layout-suffix");
    return;
  }
  if (card) card.setAttribute("data-admin-saved-layout-suffix", suffix);
  const y = readAdminSavedNudgeY(suffix);
  row.style.transform = y ? `translateY(${y})` : "";
}

/** Reaplica layout leyendo el payload guardado (por si solo se llamó syncAdminHtmlSavedRequestActionButtons). */
function syncAdminSavedRequestActionsLayoutForOperatorId(opId) {
  const id = String(opId || "").trim();
  if (!id) {
    syncAdminSavedRequestActionsLayout(null);
    return;
  }
  const modeKey = `vacaciones_last_saved_locked_mode_${id}`;
  const payloadKey = `vacaciones_last_saved_payload_${id}`;
  if (window.localStorage.getItem(modeKey) !== "1") {
    syncAdminSavedRequestActionsLayout(null);
    return;
  }
  let payload = null;
  try {
    payload = JSON.parse(window.localStorage.getItem(payloadKey) || "null");
  } catch (e) {
    payload = null;
  }
  const motive =
    payload && payload.motive != null && String(payload.motive).trim() !== ""
      ? String(payload.motive).trim()
      : "Sin motivo";
  syncAdminSavedRequestActionsLayout(motive);
}

/**
 * Consola (F12) en admin.html — desplazamiento vertical de Aceptar/Rechazar por motivo.
 * Cada función solo toca su variable (--admin-saved-nudge-y-*).
 * Más negativo = botones más arriba dentro de la tarjeta.
 */
function setPosicionBotonesSolicitudPorMotiveSuffix(suffix, desplazamientoY) {
  const v = String(desplazamientoY != null ? desplazamientoY : "").trim();
  if (!v) return;
  const varName = ADMIN_SAVED_CSS_VAR_BY_SUFFIX[suffix];
  if (!varName) return;
  document.documentElement.style.setProperty(varName, v);
  ADMIN_SAVED_NUDGE_Y_FALLBACK[suffix] = v;
  const opId = getCurrentAdminFilteredOperatorIdForPermisoActions();
  if (opId) syncAdminSavedRequestActionsLayoutForOperatorId(opId);
}

function setPosicionBotonesSolicitudVacaciones(desplazamientoY) {
  setPosicionBotonesSolicitudPorMotiveSuffix("vacaciones", desplazamientoY);
}

function setPosicionBotonesSolicitudPermisoConGoce(desplazamientoY) {
  setPosicionBotonesSolicitudPorMotiveSuffix("permiso-con-goce", desplazamientoY);
}

function setPosicionBotonesSolicitudFaltaJustificada(desplazamientoY) {
  setPosicionBotonesSolicitudPorMotiveSuffix("falta-justificada", desplazamientoY);
}

function setPosicionBotonesSolicitudPermisoSinGoce(desplazamientoY) {
  setPosicionBotonesSolicitudPorMotiveSuffix("permiso-sin-goce", desplazamientoY);
}

if (typeof window !== "undefined") {
  window.setPosicionBotonesSolicitudVacaciones =
    setPosicionBotonesSolicitudVacaciones;
  window.setPosicionBotonesSolicitudPermisoConGoce =
    setPosicionBotonesSolicitudPermisoConGoce;
  window.setPosicionBotonesSolicitudFaltaJustificada =
    setPosicionBotonesSolicitudFaltaJustificada;
  window.setPosicionBotonesSolicitudPermisoSinGoce =
    setPosicionBotonesSolicitudPermisoSinGoce;
}

function updateEstatusPermisoActionButtonsState() {
  const modifBtn = document.querySelector(".estatus-permiso-btn-modif");
  const borrarBtn = document.querySelector(".estatus-permiso-btn-borrar");
  if (!modifBtn && !borrarBtn) return;

  const role =
    state.currentRole || window.sessionStorage.getItem("vacaciones_role");
  if (role !== "admin" && role !== "maestro") {
    if (modifBtn) modifBtn.disabled = true;
    if (borrarBtn) borrarBtn.disabled = true;
    return;
  }

  if (isAdminHtmlPage()) {
    syncAdminHtmlSavedRequestActionButtons();
    return;
  }

  if (modifBtn) modifBtn.disabled = false;
  if (borrarBtn) borrarBtn.disabled = false;
}

function getCurrentAdminFilteredOperatorIdForPermisoActions() {
  const role =
    state.currentRole || window.sessionStorage.getItem("vacaciones_role");
  if (role !== "admin" && role !== "maestro") return "";
  if (state.filtered && state.filtered.length === 1 && state.filtered[0].id) {
    return String(state.filtered[0].id);
  }
  return "";
}

function setupEstatusPermisoActionButtons() {
  const wrap = document.querySelector(".estatus-permiso-actions");
  if (!wrap || wrap.dataset.bound === "1") return;
  wrap.dataset.bound = "1";
  const modifBtn = wrap.querySelector(".estatus-permiso-btn-modif");
  const borrarBtn = wrap.querySelector(".estatus-permiso-btn-borrar");
  if (!modifBtn && !borrarBtn) return;

  if (modifBtn) {
    modifBtn.addEventListener("click", function () {
      const opId = getCurrentAdminFilteredOperatorIdForPermisoActions();
      if (!opId) {
        alert("Selecciona un operador primero.");
        return;
      }
      showAdminConfirmModal("Seguro que desea modificar el estado?", function () {
        setAdminModifEstadoSession(opId);
        renderAdminSavedRequestSummary();
      });
    });
  }

  if (borrarBtn) {
    borrarBtn.addEventListener("click", function () {
      const opId = getCurrentAdminFilteredOperatorIdForPermisoActions();
      if (!opId) {
        alert("Selecciona un operador primero.");
        return;
      }
      if (
        !window.confirm(
          "¿Eliminar el estatus guardado de este permiso? Las aprobaciones quedarán en blanco (pendiente)."
        )
      ) {
        return;
      }
      clearPermisoStatusStorage(opId);
    });
  }
}

function renderPermisoStatusPillHtml(status) {
  if (status === "aprobado" || status === "autorizado") {
    return '<span class="estatus-pill estatus-pill-aprobado">Aprobado</span>';
  }
  if (status === "rechazado") {
    return '<span class="estatus-pill estatus-pill-rechazado">Rechazado</span>';
  }
  return '<span class="estatus-pill estatus-pill-pendiente">Pendiente</span>';
}

function refreshPortalPermisoStatusUI(operatorId) {
  const oid =
    operatorId !== undefined && operatorId !== null
      ? String(operatorId)
      : (window.sessionStorage.getItem("vacaciones_operator_id") || "");
  const s = getPermisoStatus(oid);
  const newJson = oid ? JSON.stringify(s) : "";
  // Siempre reconciliar historial con el permiso actual (no solo cuando cambia el JSON):
  // si todas las entradas ya tenían estadoHistorial, el ensure previo no actualizaba
  // aprobado/rechazado tras la última decisión de admin en otra pestaña.
  if (oid) {
    syncAdminRequestHistoryEstados(oid);
  }
  const elS = document.getElementById("estatusCellSupervisor");
  const elG = document.getElementById("estatusCellGerente");
  const elR = document.getElementById("estatusCellRH");
  const elF = document.getElementById("estatusCellEstadoFinal");
  if (elS) elS.innerHTML = renderPermisoStatusPillHtml(s.supervisor);
  if (elG) elG.innerHTML = renderPermisoStatusPillHtml(s.gerente);
  if (elR) elR.innerHTML = renderPermisoStatusPillHtml(s.rh);
  if (elF) elF.innerHTML = renderPermisoStatusPillHtml(s.estatusFinal);
  if (oid) __portalPermisoStatusLastJson = newJson;
  if (!isAdminHtmlPage()) {
    syncPortalModificarCambiosButtonsVisibility(oid);
    syncPortalRequestFlowUI(oid);
    maybeShowPortalFinalDecisionModal(oid);
    syncPortalPostDecisionActionsVisibility(oid);
  }
}

/**
 * portal.html (rol local): aviso cuando el estatus final es aprobado o rechazado (tres admins alineados).
 * Un solo aviso por resultado hasta que el operador pulse el botón; se resetea si se limpia el permiso.
 */
function showPortalFinalDecisionModal(opId, outcome) {
  const existing = document.getElementById("portalFinalDecisionModal");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "portalFinalDecisionModal";
  overlay.className = "portal-final-decision-modal-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute(
    "aria-label",
    outcome === "aprobado" ? "Solicitud aprobada" : "Solicitud no autorizada"
  );

  const box = document.createElement("div");
  box.className = "portal-final-decision-modal-box";

  const text = document.createElement("p");
  text.className = "portal-final-decision-modal-text";
  text.textContent =
    outcome === "aprobado"
      ? "Su solicitud ha sido aprobada con éxito"
      : "Lo sentimos, su solicitud no puede ser autorizada en este momento";

  const actions = document.createElement("div");
  actions.className = "portal-final-decision-modal-actions";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className =
    outcome === "aprobado"
      ? "portal-final-decision-modal-btn portal-final-decision-modal-btn--primary"
      : "portal-final-decision-modal-btn portal-final-decision-modal-btn--secondary";
  btn.textContent = outcome === "aprobado" ? "Aceptar" : "Volver";

  btn.addEventListener("click", function () {
    window.localStorage.setItem(portalFinalDecisionModalAckKey(opId), outcome);
    overlay.remove();
    syncPortalPostDecisionActionsVisibility(opId);
  });

  actions.appendChild(btn);
  box.appendChild(text);
  box.appendChild(actions);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

/**
 * Tras aceptar el aviso de solicitud aprobada: confirmar antes de generar nueva solicitud.
 */
function showPortalNuevaSolicitudConfirmModal(onAccept) {
  const existing = document.getElementById("portalNuevaSolicitudConfirmModal");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "portalNuevaSolicitudConfirmModal";
  overlay.className = "portal-final-decision-modal-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Confirmar nueva solicitud");

  const box = document.createElement("div");
  box.className = "portal-final-decision-modal-box";

  const text = document.createElement("p");
  text.className = "portal-final-decision-modal-text";
  text.textContent = "¿Seguro que deseas continuar?";

  const actions = document.createElement("div");
  actions.className = "portal-final-decision-modal-actions";

  const btnAccept = document.createElement("button");
  btnAccept.type = "button";
  btnAccept.className =
    "portal-final-decision-modal-btn portal-final-decision-modal-btn--primary";
  btnAccept.textContent = "Aceptar";

  const btnCancel = document.createElement("button");
  btnCancel.type = "button";
  btnCancel.className =
    "portal-final-decision-modal-btn portal-final-decision-modal-btn--secondary";
  btnCancel.textContent = "Cancelar";

  btnAccept.addEventListener("click", function () {
    overlay.remove();
    if (typeof onAccept === "function") onAccept();
  });
  btnCancel.addEventListener("click", function () {
    overlay.remove();
  });

  actions.appendChild(btnAccept);
  actions.appendChild(btnCancel);
  box.appendChild(text);
  box.appendChild(actions);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

function syncPortalPostDecisionActionsVisibility(opId) {
  const wrapApprove = document.getElementById("portalPostApproveActionsWrap");
  const wrapReject = document.getElementById("portalPostRejectActionsWrap");
  function setRow(el, show) {
    if (!el) return;
    el.style.display = show ? "flex" : "none";
    el.setAttribute("aria-hidden", show ? "false" : "true");
  }
  if (!isPortalHtmlPage()) {
    setRow(wrapApprove, false);
    setRow(wrapReject, false);
    return;
  }
  const role = window.sessionStorage.getItem("vacaciones_role");
  if (role !== "local") {
    setRow(wrapApprove, false);
    setRow(wrapReject, false);
    return;
  }
  const oid =
    opId != null && String(opId).trim() !== ""
      ? String(opId).trim()
      : (resolvePortalOperatorScopeId() || "");
  if (!oid) {
    setRow(wrapApprove, false);
    setRow(wrapReject, false);
    return;
  }
  const s = withComputedEstatusFinal(getPermisoStatus(oid));
  const v = normalizePermisoRowValue(s.estatusFinal);
  const ack = window.localStorage.getItem(portalFinalDecisionModalAckKey(oid));
  if (v === "aprobado" && ack === "aprobado") {
    setRow(wrapApprove, true);
    setRow(wrapReject, false);
  } else if (v === "rechazado" && ack === "rechazado") {
    setRow(wrapApprove, false);
    setRow(wrapReject, true);
  } else {
    setRow(wrapApprove, false);
    setRow(wrapReject, false);
  }
}

/**
 * Al cerrar un ciclo (p. ej. "Generar nueva solicitud" o reset maestro), si la solicitud
 * estaba aprobada y llevaba No. días (Vacaciones o permisos / falta justificada), suma esos días al consumo.
 * Solo cuenta si el cierre corresponde a una solicitud realmente aprobada de punta a punta:
 * no descuenta si la fila vigente es Archivada, Pendiente o reset por maestro, ni si fue rechazada.
 */
function recordVacationDaysConsumedIfApprovedVacacionesClose(operatorIdStr) {
  if (!operatorIdStr) return;
  try {
    let consumeToken = "";
    syncAdminRequestHistoryEstados(operatorIdStr);
    const s = withComputedEstatusFinal(getPermisoStatus(operatorIdStr));
    const v = normalizePermisoRowValue(s.estatusFinal);
    if (v !== "aprobado") return;

    const history = getAdminRequestHistory(operatorIdStr);
    if (history.length) {
      const latestIdx = latestHistoryEntryIndex(history);
      const latestEntry = history[latestIdx];
      if (!latestEntry) return;
      if (isMaestroArchivadaMarker(latestEntry)) return;
      const folioToken =
        latestEntry && latestEntry.firestoreFolio
          ? String(latestEntry.firestoreFolio).trim()
          : "";
      const tsToken =
        latestEntry && latestEntry.ts != null ? String(latestEntry.ts).trim() : "";
      consumeToken = folioToken || (tsToken ? "ts_" + tsToken : "");
    }

    const lastPayload = getLastSavedPayloadFromOperator(operatorIdStr);
    if (!lastPayload) return;
    const motive = String(lastPayload.motive || "").trim();
    if (!PORTAL_MOTIVOS_CONSUMEN_SALDO_VACACIONES.includes(motive)) return;
    const vals =
      lastPayload.values && typeof lastPayload.values === "object"
        ? lastPayload.values
        : {};
    const taken = getPortalDiasNoDiasFromPayloadValues(motive, vals);
    if (taken < 1) return;
    if (!consumeToken) {
      const payloadToken = JSON.stringify({
        motive: motive,
        values: vals,
      });
      consumeToken = "payload_" + payloadToken;
    }
    const key = vacationDaysConsumedStorageKey(operatorIdStr);
    const tokenKey = vacationDaysConsumedLastAppliedTokenKey(operatorIdStr);
    if (consumeToken && tokenKey) {
      const lastToken = String(window.localStorage.getItem(tokenKey) || "").trim();
      if (lastToken === consumeToken) return;
    }
    const prev = parseInt(window.localStorage.getItem(key) || "0", 10);
    const safePrev = Number.isFinite(prev) && prev > 0 ? prev : 0;
    const fallbackNext = safePrev + taken;

    // Fuente de verdad: solicitudes aprobadas en Firestore.
    // Evita doble descuento cuando el primer cierre ya fue reconstruido desde solicitudes.
    estimateVacationConsumedFromSolicitudesFirestoreDetailed(operatorIdStr)
      .then(function (rec) {
        const estimated = rec && Number.isFinite(rec.total) ? rec.total : NaN;
        let next = fallbackNext;
        if (Number.isFinite(estimated) && estimated > 0) {
          if (estimated >= safePrev && estimated <= fallbackNext) {
            next = estimated;
          } else if (estimated > fallbackNext) {
            next = estimated;
          }
        }
        window.localStorage.setItem(key, String(next));
        if (consumeToken && tokenKey) {
          window.localStorage.setItem(tokenKey, consumeToken);
        }
        syncVacationDaysConsumedToFirestore(operatorIdStr, next);
      })
      .catch(function () {
        window.localStorage.setItem(key, String(fallbackNext));
        if (consumeToken && tokenKey) {
          window.localStorage.setItem(tokenKey, consumeToken);
        }
        syncVacationDaysConsumedToFirestore(operatorIdStr, fallbackNext);
      });
  } catch (e) {
    /* ignore */
  }
}

function resetPortalOperatorForNewSolicitud(operatorId) {
  const operatorIdStr = String(operatorId || "").trim();
  if (!operatorIdStr) return;
  recordVacationDaysConsumedIfApprovedVacacionesClose(operatorIdStr);
  const lockedModeSessionKey = `vacaciones_locked_mode_${operatorIdStr}`;
  const lockedPayloadSessionKey = `vacaciones_locked_payload_${operatorIdStr}`;
  const lockedRequiredSessionKey = `vacaciones_locked_required_ids_${operatorIdStr}`;
  const lockedModeLocalKey = `vacaciones_last_saved_locked_mode_${operatorIdStr}`;
  const lockedPayloadLocalKey = `vacaciones_last_saved_payload_${operatorIdStr}`;
  // Antes de borrar el permiso: fijar en historial el resultado final (aprobado/rechazado)
  // de la solicitud que se cierra; si no, el siguiente sync interpreta "sin permiso" como pendiente.
  try {
    const s = withComputedEstatusFinal(getPermisoStatus(operatorIdStr));
    const v = normalizePermisoRowValue(s.estatusFinal);
    if (v === "aprobado" || v === "rechazado") {
      let history = getAdminRequestHistory(operatorIdStr);
      if (history.length) {
        const latestIdx = latestHistoryEntryIndex(history);
        history = history.map((entry, idx) => {
          if (idx === latestIdx) {
            const next = { ...entry, estadoHistorial: v };
            if (
              (v === "aprobado" || v === "rechazado") &&
              isMaestroArchivadaMarker(next)
            ) {
              delete next.maestroResetArchivada;
            }
            return next;
          }
          const prev = entry && entry.estadoHistorial;
          if (prev === "aprobado" || prev === "rechazado" || prev === "na") {
            return { ...entry, estadoHistorial: prev };
          }
          return { ...entry, estadoHistorial: "na" };
        });
        setAdminRequestHistory(operatorIdStr, history);
      } else {
        const lastPayload = getLastSavedPayloadFromOperator(operatorIdStr);
        if (lastPayload) {
          setAdminRequestHistory(operatorIdStr, [
            {
              ts: Date.now(),
              tipo: "Solicitud",
              payload: lastPayload,
              estadoHistorial: v,
            },
          ]);
        }
      }
      syncOperatorLatestSolicitudFirestoreStatus(operatorIdStr, v);
    }
  } catch (e) {
    /* ignore */
  }
  window.sessionStorage.removeItem(lockedModeSessionKey);
  window.sessionStorage.removeItem(lockedPayloadSessionKey);
  window.sessionStorage.removeItem(lockedRequiredSessionKey);
  window.localStorage.removeItem(lockedModeLocalKey);
  window.localStorage.removeItem(lockedPayloadLocalKey);
  // Evita que migrateGlobal… vuelva a copiar un borrador «global» al operador y reactive «Pendiente».
  window.localStorage.removeItem("vacaciones_last_saved_locked_mode_global");
  window.localStorage.removeItem("vacaciones_last_saved_payload_global");
  window.localStorage.removeItem(adminSavedDecisionLockStorageKey("global"));
  window.localStorage.removeItem(permisoStatusStorageKey(operatorIdStr));
  clearPortalFinalDecisionModalAck(operatorIdStr);
  clearAdminSavedDecisionLocked(operatorIdStr);
  clearAdminModifEstadoSession(operatorIdStr);
}

/**
 * Resuelve la entrada más reciente del historial (misma lógica que el listado en pantalla).
 * @returns {{ history: Array, entry: object, idx: number } | null}
 */
function resolveLatestHistoryEntryForPdf(opId) {
  if (!opId) return null;
  syncAdminRequestHistoryEstados(opId);
  let history = getAdminRequestHistory(opId);
  if (!history.length) {
    const lastPayload = getLastSavedPayloadFromOperator(opId);
    if (lastPayload) {
      history = [
        {
          ts: Date.now(),
          tipo: "Solicitud",
          payload: lastPayload,
          estadoHistorial:
            computeHistorialEstadoForLatestEntry(opId) || "pendiente",
        },
      ];
    }
  }
  history.sort((a, b) => (b && b.ts ? b.ts : 0) - (a && a.ts ? a.ts : 0));
  if (!history.length || !history[0]) return null;
  return { history, entry: history[0], idx: 0 };
}

/**
 * Busca una entrada por `ts` (botón Generar PDF en admin / historial).
 * @returns {{ history: Array, entry: object, idx: number } | null}
 */
function resolveHistoryEntryByTsForPdf(opId, tsStr) {
  const tsNum = Number(String(tsStr || "").trim());
  if (!opId || !tsStr || Number.isNaN(tsNum)) return null;
  syncAdminRequestHistoryEstados(opId);
  let history = resolvePortalOperatorHistoryEntriesSorted(opId);
  let idx = history.findIndex(function (e) {
    return e && Number(e.ts) === tsNum;
  });
  if (idx >= 0) return { history, entry: history[idx], idx };

  const allCache = window.__firestoreHistorialAll;
  if (Array.isArray(allCache) && allCache.length) {
    const subset = allCache
      .filter(function (e) {
        return String(e.operatorId || "") === String(opId);
      })
      .slice()
      .sort(function (a, b) {
        return (b && b.ts ? b.ts : 0) - (a && a.ts ? a.ts : 0);
      });
    idx = subset.findIndex(function (e) {
      return e && Number(e.ts) === tsNum;
    });
    if (idx >= 0) return { history: subset, entry: subset[idx], idx };
  }
  return null;
}

/**
 * HTML exclusivo para exportar a PDF (no usa recuadros del historial en pantalla).
 */
function buildSolicitudPdfDocumentHtml(opId, entry, history, idx) {
  const ts = entry && entry.ts ? new Date(entry.ts) : null;
  const tsText = ts && !Number.isNaN(ts.getTime()) ? ts.toLocaleString() : "—";
  const payload = entry && entry.payload ? entry.payload : {};
  let detailsInner = renderAdminRequestDetailsHtmlFromPayload(payload, {
    forPdf: true,
  });
  detailsInner = detailsInner.replace(
    /<div>/g,
    '<div style="margin:0 0 10px 0;">'
  );
  const estado = computeEstadoForHistoryEntry(opId, entry, idx, history);
  const estadoLabel = estadoPdfLabel(estado);
  const opNombre = resolveHistoryFooterOperatorNombre(opId);
  const opIdStr = String(opId || "").trim();
  const tituloSolicitud =
    "Solicitud " + (opIdStr !== "" ? opIdStr : "—");

  const base =
    "font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:11px;line-height:1.5;color:#111827;background:#ffffff;";
  const rowLabel =
    "padding:8px 10px;background:#f3f4f6;border:1px solid #e5e7eb;width:34%;font-weight:600;color:#374151;vertical-align:top;";
  const rowVal =
    "padding:8px 10px;border:1px solid #e5e7eb;vertical-align:top;";

  return (
    '<div style="' +
    base +
    'padding:20px 24px;max-width:720px;box-sizing:border-box;">' +
    '<div style="border-bottom:2px solid #1e3a5f;padding-bottom:8px;margin-bottom:12px;">' +
    '<div style="font-size:11px;color:#6b7280;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:3px;">SAMSONG S.A. DE C.V.</div>' +
    '<h1 style="margin:0;font-size:20px;font-weight:700;color:#1e3a5f;">' +
    escapeHtml(tituloSolicitud) +
    "</h1>" +
    "</div>" +
    '<table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:11px;">' +
    '<tr><td style="' +
    rowLabel +
    '">Operador</td><td style="' +
    rowVal +
    '">' +
    escapeHtml(opNombre || "—") +
    "</td></tr>" +
    '<tr><td style="' +
    rowLabel +
    '">Fecha y hora</td><td style="' +
    rowVal +
    '">' +
    escapeHtml(tsText) +
    "</td></tr>" +
    '<tr><td style="' +
    rowLabel +
    '">Estatus</td><td style="' +
    rowVal +
    '">' +
    escapeHtml(estadoLabel) +
    "</td></tr>" +
    "</table>" +
    '<div style="margin-top:44px;">' +
    '<div style="font-size:12px;font-weight:700;color:#1e3a5f;margin-bottom:10px;padding-left:10px;border-left:4px solid #1e3a5f;">Detalle de la solicitud</div>' +
    '<div style="border:1px solid #e5e7eb;border-radius:8px;padding:16px 18px;background:#fafafa;">' +
    detailsInner +
    "</div>" +
    "</div>" +
    "</div>"
  );
}

/**
 * Aplica Diseño 1–15 al velo de «Generando PDF» (`PDF_LOADING_VEIL_DESIGN`).
 */
function applyPdfLoadingVeilLayout(veil, design) {
  let d = Number(design);
  if (
    d !== 1 &&
    d !== 2 &&
    d !== 3 &&
    d !== 4 &&
    d !== 5 &&
    d !== 6 &&
    d !== 7 &&
    d !== 8 &&
    d !== 9 &&
    d !== 10 &&
    d !== 11 &&
    d !== 12 &&
    d !== 13 &&
    d !== 14 &&
    d !== 15
  ) {
    d = 15;
  }
  veil.setAttribute("data-pdf-loading-design", String(d));

  if (d === 1) {
    veil.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;background:#ffffff;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;";
    veil.innerHTML =
      '<div style="text-align:center;font-family:system-ui,-apple-system,sans-serif;color:#1f2937;max-width:360px;">' +
      '<p style="margin:0 0 8px 0;font-size:1.1rem;font-weight:600;">Generando PDF</p>' +
      '<p style="margin:0;font-size:0.9rem;line-height:1.45;color:#6b7280;">Por favor espera. Puede tardar unos segundos; la página puede no responder hasta terminar.</p>' +
      "</div>";
    return;
  }

  if (d === 2) {
    veil.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:32px 20px;box-sizing:border-box;background:linear-gradient(145deg,#eef2f6 0%,#dce4ec 48%,#f5f7fa 100%);";
    veil.innerHTML =
      '<div style="width:100%;max-width:420px;background:#ffffff;border-radius:16px;box-shadow:0 25px 50px -12px rgba(30,58,95,0.2),0 0 0 1px rgba(30,58,95,0.07);overflow:hidden;font-family:system-ui,-apple-system,Segoe UI,sans-serif;position:relative;">' +
      '<div style="position:absolute;left:0;top:0;bottom:0;width:5px;background:linear-gradient(180deg,#1e3a5f,#2d5a8a);"></div>' +
      '<div style="padding:26px 26px 26px 30px;">' +
      '<div style="display:flex;align-items:center;gap:18px;margin-bottom:16px;">' +
      '<svg width="42" height="42" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      "<g>" +
      '<animateTransform attributeName="transform" type="rotate" from="0 22 22" to="360 22 22" dur="0.85s" repeatCount="indefinite"/>' +
      '<circle cx="22" cy="22" r="18" stroke="#1e3a5f" stroke-width="3" fill="none" stroke-dasharray="28 85" stroke-linecap="round" opacity="0.9"/>' +
      "</g></svg>" +
      '<div style="text-align:left;min-width:0;">' +
      '<p style="margin:0;font-size:1.15rem;font-weight:700;color:#1e3a5f;letter-spacing:-0.02em;">Generando PDF</p>' +
      '<p style="margin:5px 0 0 0;font-size:0.8rem;color:#64748b;font-weight:500;">Procesando documento…</p>' +
      "</div></div>" +
      '<p style="margin:0;font-size:0.875rem;line-height:1.55;color:#475569;">Por favor espera. Puede tardar unos segundos; la página puede no responder hasta terminar.</p>' +
      "</div></div>";
    return;
  }

  if (d === 3) {
  /* Diseño 3 — variante más compacta y centrada */
  veil.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:28px 18px;box-sizing:border-box;background:radial-gradient(ellipse 115% 90% at 50% 38%,#ffffff 0%,#eef2f7 52%,#dfe7f0 100%);";
  veil.innerHTML =
    '<div style="width:100%;max-width:384px;background:#ffffff;border-radius:20px;border:1px solid #cbd5e1;box-shadow:0 12px 42px -14px rgba(15,23,42,0.18);overflow:hidden;font-family:system-ui,-apple-system,Segoe UI,sans-serif;text-align:center;">' +
    '<div style="height:4px;background:linear-gradient(90deg,#1e3a5f,#4a7ab8,#1e3a5f);"></div>' +
    '<div style="padding:30px 26px 28px;">' +
    '<div style="display:flex;justify-content:center;margin-bottom:18px;">' +
    '<svg width="52" height="14" viewBox="0 0 52 14" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<circle cx="7" cy="7" r="5" fill="#1e3a5f">' +
    '<animate attributeName="opacity" values="0.28;1;0.28" dur="1.1s" repeatCount="indefinite" begin="0s"/>' +
    "</circle>" +
    '<circle cx="26" cy="7" r="5" fill="#1e3a5f">' +
    '<animate attributeName="opacity" values="0.28;1;0.28" dur="1.1s" repeatCount="indefinite" begin="0.35s"/>' +
    "</circle>" +
    '<circle cx="45" cy="7" r="5" fill="#1e3a5f">' +
    '<animate attributeName="opacity" values="0.28;1;0.28" dur="1.1s" repeatCount="indefinite" begin="0.7s"/>' +
    "</circle>" +
    "</svg></div>" +
    '<p style="margin:0;font-size:1.06rem;font-weight:700;color:#0f172a;letter-spacing:-0.02em;">Generando PDF</p>' +
    '<p style="margin:8px 0 0 0;font-size:0.82rem;color:#64748b;">Un momento, por favor</p>' +
    '<p style="margin:18px 0 0 0;font-size:0.8125rem;line-height:1.5;color:#64748b;">Por favor espera. Puede tardar unos segundos; la página puede no responder hasta terminar.</p>' +
    "</div></div>";
    return;
  }

  if (d === 4) {
  /* Diseño 4 — alineado con .card (#31305a), --radius-lg, acento --accent y header (#31305a) */
  veil.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:28px 20px;box-sizing:border-box;background:rgba(15,23,42,0.5);backdrop-filter:saturate(160%) blur(8px);";
  veil.innerHTML =
    '<div style="position:relative;width:100%;max-width:440px;background:#31305a;border-radius:18px;border:1px solid rgba(255,255,255,0.1);box-shadow:0 28px 56px -16px rgba(15,23,42,0.55),0 0 0 1px rgba(49,48,90,0.4);overflow:hidden;font-family:system-ui,-apple-system,BlinkMacSystemFont,&quot;Segoe UI&quot;,sans-serif;">' +
    '<div style="position:absolute;inset:-45%;background:radial-gradient(circle at 0 0,rgba(56,189,248,0.12),transparent 55%);opacity:0.9;pointer-events:none;"></div>' +
    '<div style="position:relative;padding:26px 24px 22px;">' +
    '<div style="display:flex;align-items:center;gap:16px;margin-bottom:16px;">' +
    '<svg width="44" height="44" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    "<g>" +
    '<animateTransform attributeName="transform" type="rotate" from="0 22 22" to="360 22 22" dur="0.8s" repeatCount="indefinite"/>' +
    '<circle cx="22" cy="22" r="18" stroke="rgba(255,255,255,0.2)" stroke-width="3" fill="none"/>' +
    '<circle cx="22" cy="22" r="18" stroke="#22c55e" stroke-width="3" fill="none" stroke-dasharray="28 85" stroke-linecap="round"/>' +
    "</g></svg>" +
    '<div style="flex:1;min-width:0;text-align:left;">' +
    '<p style="margin:0;font-size:1.05rem;font-weight:600;letter-spacing:0.03em;color:#f1f5f9;">Generando PDF</p>' +
    '<p style="margin:6px 0 0 0;font-size:0.78rem;font-weight:500;color:rgba(226,232,240,0.75);">Exportando solicitud…</p>' +
    "</div></div>" +
    '<svg width="100%" height="8" viewBox="0 0 360 8" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:block;margin:0 0 14px;">' +
    "<defs>" +
    '<linearGradient id="pdfVeilBarGrad4" x1="0" y1="0" x2="1" y2="0">' +
    '<stop offset="0%" stop-color="#22c55e"/>' +
    '<stop offset="100%" stop-color="#4ade80"/>' +
    "</linearGradient></defs>" +
    '<rect x="0" y="0" width="360" height="8" rx="4" fill="rgba(255,255,255,0.1)"/>' +
    '<rect y="0" width="88" height="8" rx="4" fill="url(#pdfVeilBarGrad4)">' +
    '<animate attributeName="x" from="-88" to="360" dur="1.35s" repeatCount="indefinite"/>' +
    "</rect></svg>" +
    '<p style="margin:0 0 14px 0;font-size:0.82rem;line-height:1.5;color:rgba(226,232,240,0.82);">Por favor espera. Puede tardar unos segundos; la página puede no responder hasta terminar.</p>' +
    '<p style="margin:0;font-size:0.72rem;letter-spacing:0.04em;text-transform:uppercase;color:rgba(148,163,184,0.85);">Samsong S.A. de C.V.</p>' +
    "</div></div>";
    return;
  }

  if (d === 5) {
  /* Diseño 5 — .login-card / login-overlay (portal) */
  veil.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:28px 20px;box-sizing:border-box;background:radial-gradient(circle at 50% 38%,rgba(255,255,255,0.72) 0%,rgba(241,245,249,0.94) 42%,rgba(226,232,240,0.98) 100%);";
  veil.innerHTML =
    '<div style="width:100%;max-width:400px;background:rgba(35,60,105,0.9);border-radius:18px;padding:26px 24px 22px;border:1px solid rgba(148,163,184,0.35);box-shadow:0 22px 48px -14px rgba(15,23,42,0.38);font-family:system-ui,-apple-system,BlinkMacSystemFont,&quot;Segoe UI&quot;,sans-serif;text-align:center;">' +
    '<div style="display:flex;justify-content:center;margin-bottom:14px;">' +
    '<svg width="46" height="46" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" fill="none">' +
    '<path d="M14 6h14l10 10v26a4 4 0 0 1-4 4H14a4 4 0 0 1-4-4V10a4 4 0 0 1 4-4z" stroke="rgba(255,255,255,0.92)" stroke-width="2" stroke-linejoin="round"/>' +
    '<path d="M28 6v10h10" stroke="rgba(255,255,255,0.92)" stroke-width="2" stroke-linejoin="round"/>' +
    '<path d="M16 26h16M16 32h11" stroke="rgba(255,255,255,0.55)" stroke-width="1.5" stroke-linecap="round"/>' +
    "</svg></div>" +
    '<p style="margin:0;font-size:1.18rem;font-weight:600;color:#ffffff;letter-spacing:0.03em;">Generando PDF</p>' +
    '<p style="margin:7px 0 0 0;font-size:0.86rem;color:#99b5f7;">Preparando tu documento de solicitud…</p>' +
    '<div style="display:inline-flex;align-items:center;gap:10px;margin:18px 0 16px;padding:9px 16px;border-radius:999px;background:rgba(255,255,255,0.1);">' +
    '<svg width="12" height="12" viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<circle cx="6" cy="6" r="5" fill="#22c55e">' +
    '<animate attributeName="opacity" values="0.45;1;0.45" dur="1s" repeatCount="indefinite"/>' +
    "</circle></svg>" +
    '<span style="font-size:0.78rem;font-weight:500;color:rgba(255,255,255,0.88);">Trabajando en segundo plano</span></div>' +
    '<p style="margin:0;font-size:0.82rem;line-height:1.45;color:rgba(226,232,240,0.78);">Por favor espera. Puede tardar unos segundos; la página puede no responder hasta terminar.</p>' +
    "</div>";
    return;
  }

  if (d === 6) {
  /* Diseño 6 — .admin-history-item--design-2 (franja, cabecera, cuerpo, pie) */
  veil.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:26px 18px;box-sizing:border-box;background:rgba(248,250,252,0.96);";
  veil.innerHTML =
    '<div style="width:100%;max-width:436px;background:#ffffff;border-radius:10px;border:1px solid #e2e8f0;border-left:4px solid #0f172a;box-shadow:0 2px 10px rgba(15,23,42,0.07),0 14px 32px -10px rgba(15,23,42,0.12);overflow:hidden;font-family:system-ui,-apple-system,BlinkMacSystemFont,&quot;Segoe UI&quot;,sans-serif;">' +
    '<div style="padding:12px 16px 11px;background:linear-gradient(180deg,#f8fafc 0%,#ffffff 100%);border-bottom:1px solid #e2e8f0;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">' +
    '<span style="font-size:0.72rem;font-weight:800;letter-spacing:0.06em;text-transform:uppercase;color:#0f172a;">Exportación PDF</span>' +
    '<span style="font-size:0.76rem;font-weight:600;color:#64748b;white-space:nowrap;">Vacaciones SSMX</span></div>' +
    '<div style="padding:18px 16px 16px;display:flex;align-items:flex-start;gap:15px;">' +
    '<svg width="40" height="40" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    "<g>" +
    '<animateTransform attributeName="transform" type="rotate" from="0 22 22" to="360 22 22" dur="0.88s" repeatCount="indefinite"/>' +
    '<circle cx="22" cy="22" r="17" stroke="#e2e8f0" stroke-width="2.5" fill="none"/>' +
    '<circle cx="22" cy="22" r="17" stroke="#31305a" stroke-width="2.5" fill="none" stroke-dasharray="26 82" stroke-linecap="round"/>' +
    "</g></svg>" +
    '<div style="flex:1;min-width:0;">' +
    '<p style="margin:0;font-size:0.95rem;font-weight:800;letter-spacing:0.03em;text-transform:uppercase;color:#0f172a;">Generando PDF</p>' +
    '<p style="margin:8px 0 0 0;font-size:0.82rem;line-height:1.45;color:#334155;">Por favor espera. Puede tardar unos segundos; la página puede no responder hasta terminar.</p>' +
    "</div></div>" +
    '<div style="padding:9px 16px 10px;font-size:0.74rem;font-weight:600;color:#64748b;background:#f8fafc;border-top:1px solid #e2e8f0;">Samsong S.A. de C.V.</div>' +
    "</div>";
    return;
  }

  if (d === 7) {
  /* Diseño 7 — semi-formal (carta / memorando ligero) */
  veil.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:32px 20px;box-sizing:border-box;background:#f0f0ee;";
  veil.innerHTML =
    '<div style="width:100%;max-width:460px;background:#fffffe;border:1px solid #c9c9c5;box-shadow:0 1px 0 rgba(0,0,0,0.04),0 12px 28px rgba(28,25,23,0.08);font-family:system-ui,-apple-system,BlinkMacSystemFont,&quot;Segoe UI&quot;,sans-serif;">' +
    '<div style="padding:20px 30px 14px;border-bottom:3px double #78716c;">' +
    '<p style="margin:0;text-align:center;font-size:0.66rem;letter-spacing:0.16em;text-transform:uppercase;color:#57534e;font-weight:600;">Samsong S.A. de C.V.</p></div>' +
    '<div style="padding:28px 30px 24px;">' +
    '<p style="margin:0;text-align:center;font-family:Georgia,Cambria,&quot;Times New Roman&quot;,serif;font-size:1.26rem;font-weight:400;color:#1c1917;line-height:1.3;letter-spacing:-0.01em;">Generación del archivo PDF</p>' +
    '<p style="margin:10px 0 0 0;text-align:center;font-size:0.78rem;letter-spacing:0.06em;text-transform:uppercase;color:#78716c;">Documento en elaboración</p>' +
    '<div style="display:flex;justify-content:center;margin:22px 0 0;">' +
    '<svg width="42" height="42" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    "<g>" +
    '<animateTransform attributeName="transform" type="rotate" from="0 22 22" to="360 22 22" dur="1.3s" repeatCount="indefinite"/>' +
    '<circle cx="22" cy="22" r="18" stroke="#e7e5e4" stroke-width="1.5" fill="none"/>' +
    '<circle cx="22" cy="22" r="18" stroke="#44403c" stroke-width="1.5" fill="none" stroke-dasharray="22 92" stroke-linecap="round"/>' +
    "</g></svg></div>" +
    '<p style="margin:24px 0 0 0;font-size:0.84rem;line-height:1.65;color:#44403c;text-align:justify;text-justify:inter-word;">Rogamos espere unos instantes. La generación puede tardar varios segundos; durante ese intervalo la interfaz podría no responder de inmediato.</p></div>' +
    '<div style="padding:12px 30px 15px;border-top:1px solid #e7e5e4;background:#fafaf9;">' +
    '<p style="margin:0;text-align:center;font-size:0.7rem;letter-spacing:0.1em;text-transform:uppercase;color:#a8a29e;">Portal de solicitud de vacaciones · Uso interno</p></div>' +
    "</div>";
    return;
  }

  if (d === 8) {
  /* Diseño 8 — gradiente + bokeh + cristal (muy distinto al resto) */
  veil.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;overflow:hidden;padding:22px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#0c0518 0%,#1e0b3a 22%,#5b21b6 48%,#c026d3 68%,#ea580c 88%,#1c0a05 100%);";
  veil.innerHTML =
    '<div style="position:relative;width:100%;max-width:420px;min-height:200px;display:flex;align-items:center;justify-content:center;">' +
    '<div style="position:fixed;inset:0;pointer-events:none;z-index:0;">' +
    '<div style="position:absolute;left:-8%;top:12%;width:min(62vw,380px);height:min(62vw,380px);border-radius:50%;background:rgba(168,85,247,0.4);filter:blur(68px);"></div>' +
    '<div style="position:absolute;right:-10%;bottom:8%;width:min(58vw,340px);height:min(58vw,340px);border-radius:50%;background:rgba(251,191,36,0.32);filter:blur(58px);"></div>' +
    '<div style="position:absolute;left:28%;bottom:-12%;width:min(52vw,280px);height:min(52vw,280px);border-radius:50%;background:rgba(34,211,238,0.22);filter:blur(52px);"></div>' +
    "</div>" +
    '<div style="position:relative;z-index:1;width:100%;padding:30px 26px 28px;border-radius:28px;background:rgba(255,255,255,0.16);backdrop-filter:blur(22px);-webkit-backdrop-filter:blur(22px);border:1px solid rgba(255,255,255,0.42);box-shadow:0 12px 40px rgba(0,0,0,0.28),inset 0 1px 0 rgba(255,255,255,0.35);font-family:system-ui,-apple-system,BlinkMacSystemFont,&quot;Segoe UI&quot;,sans-serif;text-align:center;">' +
    '<p style="margin:0;font-size:0.68rem;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:rgba(255,255,255,0.92);text-shadow:0 1px 3px rgba(0,0,0,0.35);">Generando</p>' +
    '<p style="margin:12px 0 0 0;font-size:1.42rem;font-weight:800;line-height:1.12;color:#ffffff;letter-spacing:-0.02em;text-shadow:0 2px 20px rgba(0,0,0,0.4);">Tu PDF</p>' +
    '<p style="margin:12px 0 0 0;font-size:0.87rem;line-height:1.55;color:rgba(255,255,255,0.9);text-shadow:0 1px 6px rgba(0,0,0,0.35);">Estamos creando el archivo. Puede tardar unos segundos y la pantalla puede quedar quieta un momento.</p>' +
    '<div style="display:flex;justify-content:center;margin-top:22px;">' +
    '<svg width="46" height="46" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    "<g>" +
    '<animateTransform attributeName="transform" type="rotate" from="0 22 22" to="360 22 22" dur="0.95s" repeatCount="indefinite"/>' +
    '<circle cx="22" cy="22" r="18" stroke="rgba(255,255,255,0.25)" stroke-width="2.5" fill="none"/>' +
    '<circle cx="22" cy="22" r="18" stroke="#ffffff" stroke-width="2.5" fill="none" stroke-dasharray="26 88" stroke-linecap="round" opacity="0.95"/>' +
    "</g></svg></div>" +
    "</div></div>";
    return;
  }

  if (d === 9) {
  /* Diseño 9 — neo-brutalista (nada de degradados suaves ni cristal) */
  veil.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:24px 14px;box-sizing:border-box;background:#fef08a;";
  veil.innerHTML =
    '<div style="width:100%;max-width:392px;background:#ffffff;border:4px solid #0a0a0a;box-shadow:14px 14px 0 #0a0a0a;font-family:system-ui,-apple-system,BlinkMacSystemFont,&quot;Segoe UI&quot;,sans-serif;">' +
    '<div style="background:#0a0a0a;color:#fef08a;padding:11px 16px;font-size:0.72rem;font-weight:900;letter-spacing:0.14em;text-transform:uppercase;">PDF en proceso</div>' +
    '<div style="padding:20px 18px 18px;">' +
    '<p style="margin:0;font-size:1.85rem;font-weight:900;line-height:0.95;color:#0a0a0a;letter-spacing:-0.04em;">ESPERA</p>' +
    '<p style="margin:10px 0 0 0;font-size:0.88rem;font-weight:800;line-height:1.35;color:#0a0a0a;">Se está generando el archivo. Si la página se congela un rato, es normal.</p>' +
    '<div style="margin:16px 0 0;height:8px;background:#0a0a0a;"></div>' +
    '<div style="display:flex;justify-content:flex-start;margin-top:18px;">' +
    '<svg width="52" height="52" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    "<g>" +
    '<animateTransform attributeName="transform" type="rotate" from="0 24 24" to="360 24 24" dur="1.35s" repeatCount="indefinite"/>' +
    '<rect x="9" y="9" width="30" height="30" fill="none" stroke="#0a0a0a" stroke-width="4"/>' +
    "</g></svg></div></div>" +
    '<div style="height:12px;background:#ec4899;border-top:4px solid #0a0a0a;"></div>' +
    "</div>";
    return;
  }

  if (d === 10) {
  /* Diseño 10 — formal distinto del D7 (sin serif ni doble filete horizontal tipo carta) */
  veil.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:30px 18px;box-sizing:border-box;background:#e2eaf2;";
  veil.innerHTML =
    '<div style="width:100%;max-width:484px;background:#ffffff;box-shadow:0 4px 28px rgba(15,43,77,0.14),0 0 0 1px rgba(15,43,77,0.07);font-family:system-ui,-apple-system,BlinkMacSystemFont,&quot;Segoe UI&quot;,sans-serif;">' +
    '<div style="background:linear-gradient(180deg,#0f2b4d 0%,#153a5f 100%);padding:17px 28px 16px;border-bottom:3px solid #b8943f;">' +
    '<p style="margin:0;font-size:0.66rem;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:rgba(255,255,255,0.72);">Sistema de solicitudes</p>' +
    '<p style="margin:5px 0 0 0;font-size:1.04rem;font-weight:700;letter-spacing:0.04em;color:#ffffff;">Samsong S.A. de C.V.</p></div>' +
    '<div style="display:flex;align-items:stretch;">' +
    '<div style="width:5px;flex-shrink:0;background:linear-gradient(180deg,#c9a227 0%,#8f7328 100%);"></div>' +
    '<div style="flex:1;padding:22px 26px 20px 20px;">' +
    '<p style="margin:0;font-size:0.65rem;font-weight:600;letter-spacing:0.15em;text-transform:uppercase;color:#64748b;">Aviso de procesamiento</p>' +
    '<p style="margin:11px 0 0 0;font-size:1.07rem;font-weight:600;color:#0f2b4d;line-height:1.25;letter-spacing:-0.015em;">Generación de documento PDF</p>' +
    '<p style="margin:13px 0 0 0;font-size:0.83rem;line-height:1.65;color:#334155;">Se encuentra en curso la elaboración del archivo solicitado. Solicitamos no cerrar esta ventana hasta la finalización del proceso. La interfaz podría no responder de forma inmediata durante el tratamiento.</p>' +
    '<div style="display:flex;align-items:center;gap:13px;margin-top:18px;padding-top:15px;border-top:1px solid #e2e8f0;">' +
    '<svg width="36" height="36" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    "<g>" +
    '<animateTransform attributeName="transform" type="rotate" from="0 22 22" to="360 22 22" dur="1.25s" repeatCount="indefinite"/>' +
    '<circle cx="22" cy="22" r="17" stroke="#cbd5e1" stroke-width="2" fill="none"/>' +
    '<circle cx="22" cy="22" r="17" stroke="#0f2b4d" stroke-width="2" fill="none" stroke-dasharray="20 90" stroke-linecap="round"/>' +
    "</g></svg>" +
    '<span style="font-size:0.77rem;font-weight:600;color:#475569;letter-spacing:0.03em;">Estado: en proceso</span></div>' +
    "</div></div>" +
    '<div style="padding:9px 28px 11px;background:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;">' +
    '<p style="margin:0;font-size:0.62rem;letter-spacing:0.2em;text-transform:uppercase;color:#94a3b8;">Referencia · SSMX-GEN-PDF</p></div>' +
    "</div>";
    return;
  }

  if (d === 11) {
  /* Diseño 11 — marco tipo Polaroid (físico / nostálgico), distinto a tarjetas UI */
  veil.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:28px 16px;box-sizing:border-box;background:radial-gradient(ellipse at 30% 20%,#78716c 0%,#57534e 45%,#44403c 100%);";
  veil.innerHTML =
    '<div style="width:100%;max-width:318px;transform:rotate(-2.5deg);filter:drop-shadow(0 22px 28px rgba(0,0,0,0.45));">' +
    '<div style="background:#fafaf9;padding:13px 13px 48px 13px;box-shadow:0 0 0 1px rgba(0,0,0,0.06),inset 0 1px 0 rgba(255,255,255,0.8);font-family:system-ui,-apple-system,BlinkMacSystemFont,&quot;Segoe UI&quot;,sans-serif;">' +
    '<div style="min-height:238px;background:linear-gradient(165deg,#292524 0%,#1c1917 40%,#0c0a09 100%);display:flex;align-items:center;justify-content:center;">' +
    '<svg width="52" height="52" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    "<g>" +
    '<animateTransform attributeName="transform" type="rotate" from="0 22 22" to="360 22 22" dur="1.1s" repeatCount="indefinite"/>' +
    '<circle cx="22" cy="22" r="18" stroke="rgba(255,255,255,0.15)" stroke-width="2.5" fill="none"/>' +
    '<circle cx="22" cy="22" r="18" stroke="#fafaf9" stroke-width="2.5" fill="none" stroke-dasharray="24 90" stroke-linecap="round" opacity="0.92"/>' +
    "</g></svg></div>" +
    '<p style="margin:18px 6px 0;text-align:center;font-size:1.02rem;font-weight:700;color:#292524;letter-spacing:0.02em;">Generando PDF…</p>' +
    '<p style="margin:8px 8px 0;text-align:center;font-size:0.8rem;line-height:1.45;color:#78716c;">La imagen del documento se está revelando. Puede tardar un poco y la página puede no responder.</p>' +
    '<p style="margin:14px 6px 0;text-align:center;font-size:0.7rem;font-style:italic;color:#a8a29e;">SSMX · vacaciones</p></div></div>';
    return;
  }

  if (d === 12) {
  /* Diseño 12 — recibo / impresora térmica (monoespacio, ancho fijo) */
  veil.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:26px 12px;box-sizing:border-box;background:linear-gradient(180deg,#b8b5b2 0%,#9f9c99 100%);";
  veil.innerHTML =
    '<div style="width:100%;max-width:296px;background:#fafafa;border-top:3px dashed #52525b;border-bottom:3px dashed #52525b;box-shadow:0 8px 24px rgba(0,0,0,0.18);padding:18px 15px 14px;font-family:ui-monospace,SFMono-Regular,Consolas,&quot;Liberation Mono&quot;,monospace;">' +
    '<pre style="margin:0 0 12px;white-space:pre-wrap;font-family:inherit;font-size:0.62rem;line-height:1.45;color:#27272a;">================================\n      SSMX · COMPROBANTE\n      DE GENERACIÓN PDF\n================================\n\n  ** TRANSACCIÓN EN CURSO **\n\nEspere. Salida virtual del\narchivo en proceso.\n\nLa ventana podría no responder\nunos segundos — es esperable.\n\n--------------------------------\n</pre>' +
    '<div style="display:flex;justify-content:center;padding:4px 0 12px;">' +
    '<svg width="34" height="34" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    "<g>" +
    '<animateTransform attributeName="transform" type="rotate" from="0 22 22" to="360 22 22" dur="1.15s" repeatCount="indefinite"/>' +
    '<circle cx="22" cy="22" r="17" stroke="#d4d4d8" stroke-width="2" fill="none"/>' +
    '<circle cx="22" cy="22" r="17" stroke="#27272a" stroke-width="2" fill="none" stroke-dasharray="18 92" stroke-linecap="round"/>' +
    "</g></svg></div>" +
    '<pre style="margin:0;white-space:pre-wrap;font-family:inherit;font-size:0.56rem;line-height:1.4;color:#71717a;text-align:center;">~ no interrumpa este proceso ~\n`````````````````````````````\n   SAMSONG S.A. DE C.V.\n</pre></div>';
    return;
  }

  if (d === 13) {
  /* Diseño 13 — panel que sube desde abajo (patrón móvil / bottom sheet) */
  veil.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;padding:0;box-sizing:border-box;background:linear-gradient(0deg,rgba(15,23,42,0.58) 0%,rgba(15,23,42,0.22) 45%,rgba(15,23,42,0.08) 100%);";
  veil.innerHTML =
    '<div style="width:100%;max-width:480px;background:#ffffff;border-radius:22px 22px 0 0;box-shadow:0 -12px 40px rgba(15,23,42,0.2),0 0 0 1px rgba(15,23,42,0.06);font-family:system-ui,-apple-system,BlinkMacSystemFont,&quot;Segoe UI&quot;,sans-serif;">' +
    '<div style="width:42px;height:5px;margin:12px auto 4px;border-radius:999px;background:#e2e8f0;"></div>' +
    '<p style="margin:8px 0 0 0;text-align:center;font-size:0.68rem;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#94a3b8;">Generando documento</p>' +
    '<p style="margin:14px 24px 0;font-size:1.2rem;font-weight:700;text-align:center;color:#0f172a;letter-spacing:-0.02em;">Tu PDF está en camino</p>' +
    '<p style="margin:10px 24px 0;font-size:0.86rem;line-height:1.5;text-align:center;color:#475569;">Solo un momento. Si la página no responde unos segundos, es parte del proceso de creación del archivo.</p>' +
    '<div style="display:flex;justify-content:center;padding:22px 16px 28px;">' +
    '<svg width="44" height="44" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    "<g>" +
    '<animateTransform attributeName="transform" type="rotate" from="0 22 22" to="360 22 22" dur="1s" repeatCount="indefinite"/>' +
    '<circle cx="22" cy="22" r="18" stroke="#e2e8f0" stroke-width="2.5" fill="none"/>' +
    '<circle cx="22" cy="22" r="18" stroke="#31305a" stroke-width="2.5" fill="none" stroke-dasharray="26 88" stroke-linecap="round"/>' +
    "</g></svg></div></div>";
    return;
  }

  if (d === 14) {
  /* Diseño 14 — mensajería (avatar sistema + burbuja recibida) */
  veil.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:26px 16px;box-sizing:border-box;background:linear-gradient(180deg,#eef2ff 0%,#e0e7ff 48%,#f5f3ff 100%);";
  veil.innerHTML =
    '<div style="width:100%;max-width:404px;font-family:system-ui,-apple-system,BlinkMacSystemFont,&quot;Segoe UI&quot;,sans-serif;">' +
    '<p style="margin:0 0 14px 4px;font-size:0.72rem;font-weight:600;color:#64748b;">Sistema · Vacaciones SSMX</p>' +
    '<div style="display:flex;align-items:flex-end;gap:13px;">' +
    '<div style="flex-shrink:0;width:46px;height:46px;border-radius:50%;background:#31305a;color:#ffffff;display:flex;align-items:center;justify-content:center;font-size:0.62rem;font-weight:800;letter-spacing:0.04em;">PDF</div>' +
    '<div style="flex:1;min-width:0;background:#ffffff;border-radius:18px 18px 18px 4px;padding:15px 17px 13px;box-shadow:0 4px 16px rgba(49,48,90,0.11),0 0 0 1px rgba(49,48,90,0.07);">' +
    '<p style="margin:0 0 10px 0;font-size:0.93rem;font-weight:600;color:#0f172a;">Generando tu archivo…</p>' +
    '<div style="margin-bottom:11px;">' +
    '<svg width="52" height="10" viewBox="0 0 52 10" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<circle cx="5" cy="5" r="4" fill="#818cf8">' +
    '<animate attributeName="opacity" values="0.3;1;0.3" dur="1s" repeatCount="indefinite" begin="0s"/>' +
    "</circle>" +
    '<circle cx="26" cy="5" r="4" fill="#6366f1">' +
    '<animate attributeName="opacity" values="0.3;1;0.3" dur="1s" repeatCount="indefinite" begin="0.33s"/>' +
    "</circle>" +
    '<circle cx="47" cy="5" r="4" fill="#4f46e5">' +
    '<animate attributeName="opacity" values="0.3;1;0.3" dur="1s" repeatCount="indefinite" begin="0.66s"/>' +
    "</circle></svg></div>" +
    '<p style="margin:0;font-size:0.8rem;line-height:1.45;color:#475569;">Puede tardar unos segundos. La página podría no responder un momento; no cierres esta ventana.</p>' +
    "</div></div>" +
    '<p style="margin:12px 0 0 59px;font-size:0.66rem;color:#94a3b8;">Samsong S.A. de C.V.</p>' +
    "</div>";
    return;
  }

  if (d === 15) {
  /* Diseño 15 — claqueta / rodaje (blanco y negro, rayas diagonales) */
  veil.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:26px 14px;box-sizing:border-box;background:radial-gradient(ellipse 90% 70% at 50% 25%,#3f3f46 0%,#0a0a0a 65%);";
  veil.innerHTML =
    '<div style="width:100%;max-width:348px;border:5px solid #0a0a0a;border-radius:5px;overflow:hidden;box-shadow:0 24px 56px rgba(0,0,0,0.55);font-family:system-ui,-apple-system,BlinkMacSystemFont,&quot;Segoe UI&quot;,sans-serif;">' +
    '<div style="background:#0a0a0a;color:#fafafa;padding:13px 14px 12px;text-align:center;">' +
    '<p style="margin:0;font-size:0.64rem;font-weight:800;letter-spacing:0.28em;">ESCENA — PDF</p>' +
    '<p style="margin:5px 0 0 0;font-size:1.32rem;font-weight:900;letter-spacing:0.06em;">GENERANDO</p></div>' +
    '<div style="height:30px;background:repeating-linear-gradient(-38deg,#0a0a0a,#0a0a0a 9px,#fafafa 9px,#fafafa 18px);border-bottom:5px solid #0a0a0a;"></div>' +
    '<div style="padding:20px 17px 18px;background:#fafafa;color:#0a0a0a;">' +
    '<p style="margin:0;font-size:0.83rem;line-height:1.45;font-weight:600;">Acción: se está preparando el archivo. No cortes el proceso; la pantalla puede quedarse quieta unos segundos — es normal en el set.</p>' +
    '<div style="display:flex;justify-content:center;margin-top:17px;">' +
    '<svg width="40" height="40" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    "<g>" +
    '<animateTransform attributeName="transform" type="rotate" from="0 22 22" to="360 22 22" dur="1.05s" repeatCount="indefinite"/>' +
    '<circle cx="22" cy="22" r="17" stroke="#d4d4d4" stroke-width="2.5" fill="none"/>' +
    '<circle cx="22" cy="22" r="17" stroke="#0a0a0a" stroke-width="2.5" fill="none" stroke-dasharray="22 90" stroke-linecap="round"/>' +
    "</g></svg></div>" +
    '<p style="margin:13px 0 0 0;text-align:center;font-size:0.62rem;font-weight:800;letter-spacing:0.18em;color:#525252;">TOMA 1 · SSMX · SAMSONG</p></div></div>';
    return;
  }
}

/**
 * Genera el PDF: iframe fuera de vista + velo de carga (`applyPdfLoadingVeilLayout`); html2canvas
 * usa el documento interno del iframe (`iframeWindow`).
 */
function appendPdfSolicitudTempAndDownload(html, filename, onDone) {
  const prevBodyCursor = document.body.style.cursor;
  document.body.style.cursor = "wait";

  const iframe = document.createElement("iframe");
  iframe.setAttribute("data-pdf-solicitud-iframe", "1");
  iframe.setAttribute("aria-hidden", "true");
  iframe.setAttribute("tabindex", "-1");
  iframe.setAttribute("title", "PDF");
  /*
   * Fuera del viewport: no se ve la solicitud. La captura usa `idoc.body` + contentWindow.
   * z-index por debajo del velo de carga.
   */
  iframe.style.cssText =
    "position:fixed;left:-10000px;top:0;width:820px;height:1200px;border:0;margin:0;padding:0;background:#ffffff;pointer-events:none;z-index:2147483646;";

  const veil = document.createElement("div");
  veil.setAttribute("data-pdf-solicitud-veil", "1");
  veil.setAttribute("role", "status");
  veil.setAttribute("aria-live", "polite");
  veil.setAttribute("aria-busy", "true");
  applyPdfLoadingVeilLayout(veil, PDF_LOADING_VEIL_DESIGN);

  /*
   * html2canvas a menudo captura en blanco el HTML inyectado en la página principal
   * (CSS global, variables, modo oscuro, etc.). Un iframe con srcdoc aísla estilos.
   */
  const docHtml =
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\">" +
    "<style>html,body{margin:0;padding:0;background:#ffffff !important;color:#111827 !important;}</style></head>" +
    '<body style="margin:0;padding:12px;background:#ffffff;color:#111827;">' +
    html +
    "</body></html>";
  iframe.srcdoc = docHtml;
  document.body.appendChild(iframe);
  document.body.appendChild(veil);

  function cleanup() {
    document.body.style.cursor = prevBodyCursor || "";
    try {
      iframe.remove();
    } catch (e) {
      /* ignore */
    }
    try {
      veil.remove();
    } catch (e2) {
      /* ignore */
    }
    if (typeof onDone === "function") onDone();
  }

  let captureStarted = false;
  function runCapture() {
    if (captureStarted) return;
    const idoc = iframe.contentDocument;
    if (!idoc || !idoc.body) return;
    captureStarted = true;
    const target = idoc.body;
    setTimeout(function () {
      downloadHistoryCardPdf(target, filename, cleanup, {
        fromIframe: true,
        iframeWindow: iframe.contentWindow,
      });
    }, 50);
  }

  iframe.addEventListener("load", runCapture);
  setTimeout(function () {
    if (captureStarted) return;
    const idoc = iframe.contentDocument;
    if (idoc && idoc.body) {
      runCapture();
    } else {
      cleanup();
      alert("No se pudo preparar el contenido del PDF.");
    }
  }, 500);
}

function downloadPortalSolicitudPdf() {
  const opId = resolvePortalOperatorScopeId();
  if (!opId) return;
  const resolved = resolveLatestHistoryEntryForPdf(opId);
  if (!resolved) {
    alert("No hay solicitud para generar el PDF.");
    return;
  }
  const { history, entry, idx } = resolved;
  const html = buildSolicitudPdfDocumentHtml(opId, entry, history, idx);
  const oid = String(opId).replace(/[^\w.-]/g, "_");
  appendPdfSolicitudTempAndDownload(html, "solicitud-" + oid + ".pdf");
}

function ensureHtml2PdfAvailable() {
  if (typeof window.html2pdf === "function") {
    return Promise.resolve();
  }
  return new Promise(function (resolve, reject) {
    const existing = document.getElementById("html2pdf-lib-script");
    if (existing) {
      const finish = function () {
        if (typeof window.html2pdf === "function") resolve();
        else reject(new Error("html2pdf"));
      };
      if (typeof window.html2pdf === "function") {
        resolve();
        return;
      }
      existing.addEventListener("load", finish);
      existing.addEventListener("error", function () {
        reject(new Error("No se pudo cargar html2pdf.js"));
      });
      return;
    }
    const script = document.createElement("script");
    script.id = "html2pdf-lib-script";
    script.src =
      "https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js";
    script.crossOrigin = "anonymous";
    script.referrerPolicy = "no-referrer";
    script.onload = function () {
      if (typeof window.html2pdf === "function") resolve();
      else reject(new Error("html2pdf"));
    };
    script.onerror = function () {
      reject(new Error("No se pudo cargar html2pdf.js"));
    };
    document.head.appendChild(script);
  });
}

function downloadHistoryCardPdf(cardEl, filename, onDone, extra) {
  if (!cardEl) return;
  extra = extra || {};
  const fromIframe = !!extra.fromIframe;
  const iframeWin = extra.iframeWindow || null;
  ensureHtml2PdfAvailable()
    .then(function () {
      const ownerDoc = cardEl.ownerDocument || document;
      const scrollYMain = ownerDoc === document ? -window.scrollY : 0;
      const html2canvasOpts = {
        scale: PDF_HTML2CANVAS_SCALE,
        useCORS: true,
        allowTaint: true,
        logging: false,
        letterRendering: true,
        foreignObjectRendering: false,
        scrollX: 0,
        scrollY: fromIframe ? 0 : scrollYMain,
        backgroundColor: "#ffffff",
        onclone: function (clonedDoc, clonedEl) {
          try {
            if (clonedDoc && clonedDoc.documentElement) {
              clonedDoc.documentElement.style.background = "#ffffff";
              clonedDoc.documentElement.style.color = "#111827";
            }
            if (clonedDoc && clonedDoc.body) {
              clonedDoc.body.style.background = "#ffffff";
              clonedDoc.body.style.color = "#111827";
            }
            if (clonedEl && clonedEl.style) {
              clonedEl.style.background = "#ffffff";
              clonedEl.style.color = "#111827";
            }
          } catch (e) {
            /* ignore */
          }
        },
      };
      if (iframeWin && typeof iframeWin === "object") {
        html2canvasOpts.window = iframeWin;
      }
      const opt = {
        margin: [12, 10, 12, 10],
        filename: filename,
        /* JPEG codifica más rápido que PNG; calidad alta mantiene buen aspecto en texto. */
        image: { type: "jpeg", quality: 0.95 },
        html2canvas: html2canvasOpts,
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
        pagebreak: { mode: ["avoid-all", "css", "legacy"] },
      };
      return window.html2pdf().set(opt).from(cardEl).save();
    })
    .catch(function () {
      alert("No se pudo generar el PDF. Intenta de nuevo.");
    })
    .then(function () {
      if (typeof onDone === "function") onDone();
    });
}

function setupHistoryPdfButtons() {
  if (window.__historyPdfButtonsBound) return;
  window.__historyPdfButtonsBound = true;

  document.addEventListener("click", function (ev) {
    const btn = ev.target && ev.target.closest
      ? ev.target.closest(".admin-history-item-pdf-btn")
      : null;
    if (!btn) return;

    const ts = (btn.getAttribute("data-history-ts") || "").trim();
    const opId = (btn.getAttribute("data-history-op-id") || "").trim();
    const resolved = resolveHistoryEntryByTsForPdf(opId, ts);
    if (!resolved) {
      alert("No se encontró la solicitud para generar el PDF.");
      return;
    }
    const { history, entry, idx } = resolved;
    const html = buildSolicitudPdfDocumentHtml(opId, entry, history, idx);
    const tsPart = ts ? ts : String(Date.now());
    const opPart = (opId || "operador").replace(/[^\w.-]/g, "_");
    appendPdfSolicitudTempAndDownload(
      html,
      "solicitud-" + opPart + "-" + tsPart + ".pdf"
    );
  });
}

function setupPortalPostApproveActions() {
  if (window.__portalPostDecisionActionsSetup) return;
  window.__portalPostDecisionActionsSetup = true;

  const btnPdf = document.getElementById("portalBtnGenerarPdfSolicitud");
  if (btnPdf) {
    btnPdf.addEventListener("click", function () {
      downloadPortalSolicitudPdf();
    });
  }

  function runPortalGenerarNuevaSolicitud() {
    const oid = resolvePortalOperatorScopeId();
    if (!oid) return;
    resetPortalOperatorForNewSolicitud(oid);
    window.location.reload();
  }

  /** Flujo aprobado (tras modal "Su solicitud ha sido..."): recuadro con solo "Aceptar". */
  function attachGenerarNuevaSolicitudApprove(btn) {
    if (!btn) return;
    btn.addEventListener("click", function () {
      showPortalNuevaSolicitudConfirmModal(runPortalGenerarNuevaSolicitud);
    });
  }

  function attachGenerarNuevaSolicitudReject(btn) {
    if (!btn) return;
    btn.addEventListener("click", function () {
      showPortalNuevaSolicitudConfirmModal(runPortalGenerarNuevaSolicitud);
    });
  }
  attachGenerarNuevaSolicitudApprove(
    document.getElementById("portalBtnGenerarNuevaSolicitud")
  );
  attachGenerarNuevaSolicitudReject(
    document.getElementById("portalBtnGenerarNuevaSolicitudReject")
  );
}

function maybeShowPortalFinalDecisionModal(operatorId) {
  if (!isPortalHtmlPage()) return;
  const role = window.sessionStorage.getItem("vacaciones_role");
  if (role !== "local") return;

  const oid =
    operatorId !== undefined && operatorId !== null
      ? String(operatorId).trim()
      : (window.sessionStorage.getItem("vacaciones_operator_id") || "").trim();
  if (!oid) return;

  const s = withComputedEstatusFinal(getPermisoStatus(oid));
  const v = normalizePermisoRowValue(s.estatusFinal);
  if (v !== "aprobado" && v !== "rechazado") return;

  if (window.localStorage.getItem(portalFinalDecisionModalAckKey(oid)) === v) {
    return;
  }

  if (document.getElementById("portalFinalDecisionModal")) return;

  showPortalFinalDecisionModal(oid, v);
}

function showAdminConfirmModal(message, onAccept) {
  const existing = document.getElementById("adminConfirmModal");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "adminConfirmModal";
  overlay.style.position = "fixed";
  overlay.style.inset = "0";
  overlay.style.background = "rgba(0,0,0,0.25)";
  overlay.style.display = "flex";
  overlay.style.alignItems = "center";
  overlay.style.justifyContent = "center";
  overlay.style.zIndex = "9999";

  const box = document.createElement("div");
  box.style.background = "#ffffff";
  box.style.border = "1px solid #cccccc";
  box.style.borderRadius = "14px";
  box.style.padding = "18px 20px";
  box.style.width = "min(380px, 92vw)";

  const text = document.createElement("div");
  text.textContent = message;
  text.style.color = "#000000";
  text.style.fontSize = "0.95rem";
  text.style.lineHeight = "1.4";
  text.style.marginBottom = "14px";
  text.style.textAlign = "center";

  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.alignItems = "center";
  actions.style.justifyContent = "center";
  actions.style.gap = "12px";

  const accept = document.createElement("button");
  accept.type = "button";
  accept.textContent = "Aceptar";
  accept.style.border = "none";
  accept.style.borderRadius = "999px";
  accept.style.padding = "8px 18px";
  accept.style.background = "#31305a";
  accept.style.color = "#ffffff";
  accept.style.cursor = "pointer";
  accept.style.fontSize = "0.9rem";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancelar";
  cancel.style.border = "none";
  cancel.style.borderRadius = "999px";
  cancel.style.padding = "8px 18px";
  cancel.style.background = "#e5e7eb";
  cancel.style.color = "#000000";
  cancel.style.cursor = "pointer";
  cancel.style.fontSize = "0.9rem";

  accept.addEventListener("click", function () {
    overlay.remove();
    if (typeof onAccept === "function") onAccept();
  });
  cancel.addEventListener("click", function () {
    overlay.remove();
  });

  actions.appendChild(accept);
  actions.appendChild(cancel);
  box.appendChild(text);
  box.appendChild(actions);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

function setupAdminPermisoDecisionButtons() {
  const wrap = document.getElementById("adminSavedRequestCard");
  const acceptBtn = wrap
    ? wrap.querySelector(".admin-saved-action-accept")
    : document.querySelector(".admin-saved-action-accept");
  const rejectBtn = wrap
    ? wrap.querySelector(".admin-saved-action-reject")
    : document.querySelector(".admin-saved-action-reject");
  if (!acceptBtn || !rejectBtn) return;
  if (acceptBtn.dataset.bound === "1") return;
  acceptBtn.dataset.bound = "1";
  rejectBtn.dataset.bound = "1";

  function showAdminDecisionConfirmModal(onAccept) {
    showAdminConfirmModal("Seguro que desea continuar?", onAccept);
  }

  const applyDecision = (kind) => {
    const profile = window.sessionStorage.getItem("vacaciones_admin_profile");
    if (!state.filtered || state.filtered.length !== 1) {
      alert("Busca y selecciona un operador (ID 1001–1500) primero.");
      return;
    }
    if (!profile) {
      alert(
        "Inicia sesión con Supervisor2026, DeptManag2026 o LuisHHRR2026 para autorizar o rechazar la fila que te corresponde."
      );
      return;
    }
    const opId = String(state.filtered[0].id);
    const value = kind === "accept" ? "aprobado" : "rechazado";
    clearAdminModifEstadoSession(opId);
    setPermisoStatusField(opId, profile, value);
    refreshPortalPermisoStatusUI(opId);
    renderAdminSavedRequestSummary();
    const filaNombre =
      profile === "supervisor"
        ? "Supervisor"
        : profile === "gerente"
          ? "Gerente Dpto"
          : "RH";
    const actionText = kind === "accept" ? "Aprobado" : "Rechazado";
  };

  acceptBtn.addEventListener("click", () =>
    showAdminDecisionConfirmModal(() => applyDecision("accept"))
  );
  rejectBtn.addEventListener("click", () =>
    showAdminDecisionConfirmModal(() => applyDecision("reject"))
  );
}

function randomFrom(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function randomInt(min, maxInclusive) {
  return Math.floor(Math.random() * (maxInclusive - min + 1)) + min;
}

function escapeHtml(str) {
  if (str == null) return "";
  const s = String(str);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Fecha de ingreso fija por índice (base 2015-01-01 + 7 días por operador)
function fixedHireDateForIndex(index1Based) {
  const base = new Date(2015, 0, 1);
  const d = new Date(base);
  d.setDate(d.getDate() + (index1Based - 1) * 7);
  return d.toISOString().slice(0, 10);
}

function generateOperators(count = 500) {
  const nombres = [
    "Ana", "Luis", "María", "Carlos", "Lucía", "Jorge", "Sofía", "Miguel",
    "Valeria", "Diego", "Paola", "Andrés", "Fernanda", "Raúl", "Diana"
  ];
  const apellidos = [
    "García", "Hernández", "López", "Martínez", "Ramírez",
    "Flores", "Torres", "Vargas", "Castillo", "Mendoza"
  ];
  const puestos = [
    "Op. de línea",
    "Op. de almacén",
    "Op. de logística",
    "Op. de calidad",
    "Op. de soporte"
  ];
  const turnos = ["Mañana", "Tarde", "Noche"];

  // 500 nombres fijos: se repiten las 150 combinaciones nombre+apellido de forma determinista
  const nNombres = nombres.length;
  const nApellidos = apellidos.length;
  const operators = [];

  for (let i = 1; i <= count; i++) {
    const id = String(1000 + i);
    const idx = i - 1;
    const nombre = nombres[idx % nNombres];
    const apellido = apellidos[Math.floor(idx / nNombres) % nApellidos];
    const nombreCompleto = `${nombre} ${apellido}`;

    const puesto = puestos[idx % puestos.length];
    const turno = turnos[idx % turnos.length];
    const fechaIngreso = fixedHireDateForIndex(i);

    const motivo = MOTIVOS[idx % MOTIVOS.length];
    const diasInhabiles = idx % 11;
    const diasVacacionales = DIAS_VACACIONALES_BASE;
    const diasDisponibles = Math.max(diasVacacionales - diasInhabiles, 0);

    const supervisorAprueba = (idx % 5) !== 0;
    const gerenteAprueba = supervisorAprueba && (idx % 4) !== 0;
    const rhAprueba = gerenteAprueba && (idx % 10) !== 0;
    const estadoFinal =
      supervisorAprueba && gerenteAprueba && rhAprueba
        ? "Aprobado"
        : "Pendiente / Rechazado";

    operators.push({
      id,
      nombreCompleto,
      puesto,
      fechaIngreso,
      turno,
      motivo,
      diasVacacionales,
      diasInhabiles,
      diasDisponibles,
      supervisorAprueba,
      gerenteAprueba,
      rhAprueba,
      estadoFinal
    });
  }

  return operators;
}

const state = {
  operators: [],
  filtered: [],
  selectionMessage: "",
  currentRole: null, // "admin" | "local"
  currentOperatorId: null
};

/** Nombres de mes en portal.html (valores de <select> de mes). */
const PORTAL_MESES_NOMBRES = [
  "Enero",
  "Febrero",
  "Marzo",
  "Abril",
  "Mayo",
  "Junio",
  "Julio",
  "Agosto",
  "Septiembre",
  "Octubre",
  "Noviembre",
  "Diciembre"
];

/** Año civil actual (selectores de fecha del portal). */
function getPortalCalendarYear() {
  return new Date().getFullYear();
}

function portalDaysInMonth(year, monthIndex0) {
  return new Date(year, monthIndex0 + 1, 0).getDate();
}

function portalSyncAnioDisplay(anioHiddenEl) {
  if (!anioHiddenEl || !anioHiddenEl.id) return;
  const wrap = anioHiddenEl.previousElementSibling;
  if (!wrap || !wrap.classList.contains("portal-anio-curso")) return;
  const valEl = wrap.querySelector(".portal-anio-curso-val");
  const y = String(anioHiddenEl.value || "").trim();
  if (valEl) valEl.textContent = y || "Año";
  wrap.classList.toggle("portal-anio-curso-placeholder", !y);
}

/**
 * Opciones de día según mes y año (febrero bisiesto, etc.).
 * @param {{ silent?: boolean }} [opts] si silent, no dispara change en día
 */
function portalFillDiaOptionsForMes(diaSel, mesSel, year, opts) {
  if (!diaSel || !mesSel) return;
  const silent = opts && opts.silent;
  const prev = String(diaSel.value || "").trim();
  const mesVal = String(mesSel.value || "").trim();
  const mi = PORTAL_MESES_NOMBRES.indexOf(mesVal);

  diaSel.innerHTML = "";
  const ph = document.createElement("option");
  ph.value = "";
  ph.textContent = "Día";
  diaSel.appendChild(ph);

  if (mi < 0) {
    diaSel.value = "";
    if (!silent)
      diaSel.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  const max = portalDaysInMonth(year, mi);
  for (let d = 1; d <= max; d++) {
    const opt = document.createElement("option");
    opt.value = String(d);
    opt.textContent = String(d);
    diaSel.appendChild(opt);
  }

  const prevNum = parseInt(prev, 10);
  if (prevNum >= 1 && prevNum <= max) diaSel.value = String(prevNum);
  else diaSel.value = "";

  if (!silent)
    diaSel.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Selects de «día» del portal: las opciones dependen de mes y año.
 * Al rehidratar modo bloqueado, si se asigna el día antes de rellenar opciones,
 * el valor no «pega» y el selector queda en el placeholder «Día».
 */
const PORTAL_DIA_SELECT_IDS = new Set([
  "fechaDiaSelect",
  "fechaDiaSelectFin",
  "fechaPermisoDiaSelect",
  "fechaPermisoDiaSelectFin",
  "fechaJustificarDiaSelect",
  "fechaJustificarDiaSelectFin",
  "fechaPermisoSinGoceDiaSelect",
  "fechaPermisoSinGoceDiaSelectFin",
]);

function applyPortalLockedFieldValuesExcludingDia(values) {
  if (!values) return;
  Object.keys(values).forEach(function (id) {
    if (PORTAL_DIA_SELECT_IDS.has(id)) return;
    const el = document.getElementById(id);
    if (!el) return;
    el.value = values[id] ?? "";
  });
}

function applyPortalLockedDiaFieldValuesOnly(values) {
  if (!values) return;
  Object.keys(values).forEach(function (id) {
    if (!PORTAL_DIA_SELECT_IDS.has(id)) return;
    const el = document.getElementById(id);
    if (!el) return;
    el.value = values[id] ?? "";
  });
}

/** Mes → { dia, anio, inicio }; inicio fuerza año al año en curso al cambiar mes. */
const PORTAL_MES_TO_PAIR = {
  fechaMesSelect: {
    dia: "fechaDiaSelect",
    anio: "fechaAnioSelect",
    inicio: true
  },
  fechaMesSelectFin: {
    dia: "fechaDiaSelectFin",
    anio: "fechaAnioSelectFin",
    inicio: false
  },
  fechaPermisoMesSelect: {
    dia: "fechaPermisoDiaSelect",
    anio: "fechaPermisoAnioSelect",
    inicio: true
  },
  fechaPermisoMesSelectFin: {
    dia: "fechaPermisoDiaSelectFin",
    anio: "fechaPermisoAnioSelectFin",
    inicio: false
  },
  fechaJustificarMesSelect: {
    dia: "fechaJustificarDiaSelect",
    anio: "fechaJustificarAnioSelect",
    inicio: true
  },
  fechaJustificarMesSelectFin: {
    dia: "fechaJustificarDiaSelectFin",
    anio: "fechaJustificarAnioSelectFin",
    inicio: false
  },
  fechaPermisoSinGoceMesSelect: {
    dia: "fechaPermisoSinGoceDiaSelect",
    anio: "fechaPermisoSinGoceAnioSelect",
    inicio: true
  },
  fechaPermisoSinGoceMesSelectFin: {
    dia: "fechaPermisoSinGoceDiaSelectFin",
    anio: "fechaPermisoSinGoceAnioSelectFin",
    inicio: false
  }
};

const PORTAL_ANIO_INICIO_IDS = [
  "fechaAnioSelect",
  "fechaPermisoAnioSelect",
  "fechaJustificarAnioSelect",
  "fechaPermisoSinGoceAnioSelect"
];

/** Evita borrar el año inicio al rellenar opciones de día (p. ej. rehidratación modo bloqueado). */
let portalBulkRefreshingDiaOptions = false;

let portalSaldoWarningEnabled = false;
let portalSaldoDescontarInputEnabled = false;

function enablePortalSaldoWarning() {
  portalSaldoWarningEnabled = true;
  syncPortalDiasDisponiblesLabels();
}

function enablePortalSaldoWarningWithDiscount() {
  portalSaldoWarningEnabled = true;
  portalSaldoDescontarInputEnabled = true;
  syncPortalDiasDisponiblesLabels();
}

function portalOnMesSelectChange(mesEl) {
  if (!mesEl || !mesEl.id) return;
  const pair = PORTAL_MES_TO_PAIR[mesEl.id];
  if (!pair) return;
  const diaEl = document.getElementById(pair.dia);
  const anioEl = document.getElementById(pair.anio);

  const mesVal = String(mesEl.value || "").trim();
  const mi = PORTAL_MESES_NOMBRES.indexOf(mesVal);

  const yRaw = anioEl && anioEl.value ? String(anioEl.value).trim() : "";
  const yParsed = parseInt(yRaw, 10);
  const yearForDays =
    Number.isFinite(yParsed) && yParsed > 0 ? yParsed : getPortalCalendarYear();

  portalFillDiaOptionsForMes(diaEl, mesEl, yearForDays, { silent: true });

  if (pair.inicio && anioEl && !portalBulkRefreshingDiaOptions) {
    const mesOk = mesVal !== "" && mi >= 0;
    const diaOk = diaEl && String(diaEl.value || "").trim() !== "";
    if (!mesOk || !diaOk) {
      anioEl.value = "";
      portalSyncAnioDisplay(anioEl);
      anioEl.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      anioEl.value = String(getPortalCalendarYear());
      portalSyncAnioDisplay(anioEl);
      anioEl.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  if (diaEl) {
    diaEl.classList.toggle("fecha-select-placeholder", diaEl.value === "");
  }
}

function portalRefreshAllPortalDiaOptions() {
  portalBulkRefreshingDiaOptions = true;
  try {
    Object.keys(PORTAL_MES_TO_PAIR).forEach(function (mesId) {
      const mesEl = document.getElementById(mesId);
      if (mesEl) portalOnMesSelectChange(mesEl);
    });
  } finally {
    portalBulkRefreshingDiaOptions = false;
  }
}

/** Año inicio: vacío en carga hasta elegir mes y día (el visible muestra solo «Año»). */
function portalClearAllInicioAnioHiddenAndDisplay() {
  PORTAL_ANIO_INICIO_IDS.forEach(function (id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = "";
    portalSyncAnioDisplay(el);
  });
}

const portalFechaFinPairSyncers = [];

function getPortalDiasDisponiblesForFechas() {
  const role = window.sessionStorage.getItem("vacaciones_role");
  if (role !== "local") return DIAS_VACACIONALES_BASE;
  const sid = (
    window.sessionStorage.getItem("vacaciones_operator_id") || ""
  ).trim();
  if (sid) return getPortalVacationSaldoRestante(sid);
  if (state.filtered && state.filtered.length === 1 && state.filtered[0].id) {
    return getPortalVacationSaldoRestante(String(state.filtered[0].id));
  }
  return DIAS_VACACIONALES_BASE;
}

/** Valor numérico del campo No. días activo según motivo seleccionado (portal local). */
function getPortalDiasEnCampoNoDiasPorMotivoActual() {
  const motivoSelect = document.getElementById("motivoSelectLocal");
  const motive = motivoSelect && motivoSelect.value ? String(motivoSelect.value).trim() : "";
  const idByMotive = {
    Vacaciones: "diasSolicitadosInput",
    "Permiso con goce": "diasSolicitadosPermisoGoceInput",
    "Falta justificada": "diasSolicitadosFaltaJustificadaInput",
    "Permiso sin goce": "diasSolicitadosPermisoSinGoceInput"
  };
  const fieldId = idByMotive[motive];
  if (!fieldId) return 0;
  const el = document.getElementById(fieldId);
  const n = parseInt(String(el && el.value ? el.value : "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Saldo mostrado junto a «No. de días disponibles»: tope restante menos lo indicado en No. días del motivo actual.
 */
function getPortalDiasDisponiblesParaEtiquetaPortal() {
  const role = window.sessionStorage.getItem("vacaciones_role");
  const base = getPortalDiasDisponiblesForFechas();
  if (role !== "local") return base;
  if (!portalSaldoDescontarInputEnabled) return base;
  const enFormulario = getPortalDiasEnCampoNoDiasPorMotivoActual();
  return Math.max(0, base - enFormulario);
}

/**
 * Saldo de vacaciones ya reflejado en almacenamiento (cierres aprobados), sin restar la solicitud en curso.
 * El texto/número en rojo de «sin saldo» solo aplica cuando esto es 0 (p. ej. nueva solicitud sin días),
 * no cuando en la misma solicitud el contador llega a 0 al descontar el No. días del formulario.
 */
function getPortalSaldoVacacionalPeriodoPersistido() {
  const role = window.sessionStorage.getItem("vacaciones_role");
  if (role !== "local") return DIAS_VACACIONALES_BASE;
  const opId = (resolvePortalOperatorScopeId() || "").trim();
  if (!opId) return DIAS_VACACIONALES_BASE;
  return getPortalVacationSaldoRestante(opId);
}

/** Vacaciones: desplazamiento en días calendario para la 2.ª fecha = No. días. */
function getPortalVacacionesDiasSolicitadosParaFechaFin() {
  const el = document.getElementById("diasSolicitadosInput");
  const n = parseInt(String(el && el.value ? el.value : "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Permiso con goce: misma regla que Vacaciones para la 2.ª fecha. */
function getPortalPermisoGoceDiasSolicitadosParaFechaFin() {
  const el = document.getElementById("diasSolicitadosPermisoGoceInput");
  const n = parseInt(String(el && el.value ? el.value : "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Falta justificada: misma regla para la 2.ª fecha. */
function getPortalFaltaJustificadaDiasParaFechaFin() {
  const el = document.getElementById("diasSolicitadosFaltaJustificadaInput");
  const n = parseInt(String(el && el.value ? el.value : "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Permiso sin goce: misma regla para la 2.ª fecha. */
function getPortalPermisoSinGoceDiasParaFechaFin() {
  const el = document.getElementById("diasSolicitadosPermisoSinGoceInput");
  const n = parseInt(String(el && el.value ? el.value : "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function syncPortalDiasDisponiblesLabels() {
  const n = getPortalDiasDisponiblesParaEtiquetaPortal();
  const saldoPersistido = getPortalSaldoVacacionalPeriodoPersistido();
  const sinSaldoEnPeriodo = saldoPersistido <= 0;
  document.querySelectorAll(".diasDisponiblesValue").forEach(function (el) {
    el.textContent = String(n);
    el.classList.toggle("diasDisponiblesValue--zero", sinSaldoEnPeriodo);
  });
  const saldoMsg = "No dispone de saldo de vacaciones en su periodo actual.";
  document.querySelectorAll(".portal-dias-saldo-warning").forEach(function (el) {
    const show = sinSaldoEnPeriodo;
    el.textContent = show ? saldoMsg : "";
    el.style.display = show ? "block" : "none";
  });
}

/**
 * Campo numérico "No. días" (Vacaciones, permisos con/sin goce o Falta justificada): validación 1…saldo y recálculo de fecha fin.
 * @param {string} inputId
 * @param {string|null} errorId id del span de error, o null si no hay mensajes bajo el campo
 * @param {{ silentDiasField?: boolean }} [options] Sin mensajes bajo el campo; valor fuera de 1–20 se borra al presionar Enter (Permiso con goce, Falta justificada, Permiso sin goce)
 */
function bindPortalDiasSolicitadosInputConSync(inputId, errorId, options) {
  const diasSolicitadosInput = document.getElementById(inputId);
  const diasSolicitadosError = errorId
    ? document.getElementById(errorId)
    : null;
  if (!diasSolicitadosInput) return;

  const silentDiasField =
    options && typeof options === "object" && options.silentDiasField === true;
  const maxRango = DIAS_VACACIONALES_BASE;

  function clearErrorIfAny() {
    if (diasSolicitadosError) diasSolicitadosError.textContent = "";
  }

  function validarDiasSolicitados(desdeEnter = false) {
    const v = diasSolicitadosInput.value.trim();
    if (v === "") {
      clearErrorIfAny();
      if (!silentDiasField && desdeEnter && diasSolicitadosError) {
        diasSolicitadosError.textContent = "Por favor ingrese un número";
      }
      return false;
    }
    const n = parseInt(v, 10);
    /* Solo 1…20: si se usara saldo restante y fuera 0, n > 0 invalidaría cualquier dígito. */
    if (isNaN(n) || n < 1 || n > maxRango) {
      if (silentDiasField) {
        if (desdeEnter) diasSolicitadosInput.value = "";
        clearErrorIfAny();
      } else if (diasSolicitadosError) {
        diasSolicitadosError.textContent =
          "Por favor, ingrese un número entre 1 y " + String(maxRango);
      }
      return false;
    }
    clearErrorIfAny();
    return true;
  }

  diasSolicitadosInput.addEventListener("keydown", function (e) {
    const isEnter =
      e.key === "Enter" ||
      e.key === "NumpadEnter" ||
      e.keyCode === 13 ||
      e.which === 13;
    if (isEnter) {
      e.preventDefault();
      e.stopPropagation();
      const esValido = validarDiasSolicitados(true);
      if (esValido) {
        syncAllPortalFechaFinDerivadas();
        syncPortalDiasDisponiblesLabels();
        this.blur();
      }
      return;
    }
    const permitidas = [
      "Backspace",
      "Delete",
      "Tab",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End"
    ];
    if (permitidas.includes(e.key)) return;
    if (e.key.length === 1 && /\d/.test(e.key)) return;
    e.preventDefault();
  });

  diasSolicitadosInput.addEventListener("input", function () {
    this.value = this.value.replace(/\D/g, "");
    if (silentDiasField) {
      clearErrorIfAny();
    } else if (this.value.trim() !== "" && diasSolicitadosError) {
      diasSolicitadosError.textContent = "";
    }
    syncAllPortalFechaFinDerivadas();
    syncPortalDiasDisponiblesLabels();
  });

  diasSolicitadosInput.addEventListener("blur", function () {
    validarDiasSolicitados();
    syncAllPortalFechaFinDerivadas();
    syncPortalDiasDisponiblesLabels();
  });
}

function portalParseDateFromSelectElements(diaEl, mesEl, anioEl) {
  if (!diaEl || !mesEl || !anioEl) return null;
  const d = parseInt(String(diaEl.value || "").trim(), 10);
  const y = parseInt(String(anioEl.value || "").trim(), 10);
  const mesVal = String(mesEl.value || "").trim();
  const mi = PORTAL_MESES_NOMBRES.indexOf(mesVal);
  if (!d || !y || mi < 0) return null;
  const dt = new Date(y, mi, d);
  if (
    dt.getFullYear() !== y ||
    dt.getMonth() !== mi ||
    dt.getDate() !== d
  ) {
    return null;
  }
  return dt;
}

function portalAddCalendarDays(date, n) {
  const r = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate()
  );
  r.setDate(r.getDate() + n);
  return r;
}

function portalSetDateOnSelectElements(diaEl, mesEl, anioEl, date) {
  if (!diaEl || !mesEl || !anioEl || !date) return;
  const y = date.getFullYear();
  const m = date.getMonth();
  const d = date.getDate();
  mesEl.value = PORTAL_MESES_NOMBRES[m];
  anioEl.value = String(y);
  portalFillDiaOptionsForMes(diaEl, mesEl, y, { silent: true });
  diaEl.value = String(d);
  portalSyncAnioDisplay(anioEl);
  diaEl.dispatchEvent(new Event("change", { bubbles: true }));
  mesEl.dispatchEvent(new Event("change", { bubbles: true }));
  anioEl.dispatchEvent(new Event("change", { bubbles: true }));
}

function clearPortalFechaFinDerivacionSyncers() {
  portalFechaFinPairSyncers.length = 0;
}

/**
 * portal.html (rol local): segunda fecha (tras "A") derivada de la primera + N días calendario.
 * @param {object} pairIds ids día/mes/año inicio y fin
 * @param {function(): number} [getSpanDays] N a sumar; por defecto días disponibles (tope). Vacaciones, ambos permisos y Falta justificada usan el campo No. días.
 */
function registerPortalFechaFinDerivacion(pairIds, getSpanDays) {
  const spanFn =
    typeof getSpanDays === "function"
      ? getSpanDays
      : getPortalDiasDisponiblesForFechas;

  const diaIn = () => document.getElementById(pairIds.diaInicio);
  const mesIn = () => document.getElementById(pairIds.mesInicio);
  const anioIn = () => document.getElementById(pairIds.anioInicio);
  const diaFin = () => document.getElementById(pairIds.diaFin);
  const mesFin = () => document.getElementById(pairIds.mesFin);
  const anioFin = () => document.getElementById(pairIds.anioFin);

  function syncOne() {
    const dIn = diaIn();
    const mIn = mesIn();
    const aIn = anioIn();
    const dF = diaFin();
    const mF = mesFin();
    const aF = anioFin();
    if (!dIn || !mIn || !aIn || !dF || !mF || !aF) return;
    if (dF.disabled) return;

    [dF, mF, aF].forEach(function (el) {
      el.classList.add("fecha-fin-autoderivada");
      el.setAttribute("aria-readonly", "true");
      el.tabIndex = -1;
    });
    const aFinDisplay = aF.previousElementSibling;
    if (aFinDisplay && aFinDisplay.classList.contains("portal-anio-curso")) {
      aFinDisplay.classList.add("fecha-fin-autoderivada");
      aFinDisplay.setAttribute("aria-readonly", "true");
    }

    const spanDays = spanFn();
    const start = portalParseDateFromSelectElements(dIn, mIn, aIn);
    if (!start || spanDays <= 0) {
      dF.value = "";
      mF.value = "";
      aF.value = "";
      portalFillDiaOptionsForMes(dF, mF, getPortalCalendarYear(), {
        silent: true
      });
      portalSyncAnioDisplay(aF);
      dF.dispatchEvent(new Event("change", { bubbles: true }));
      mF.dispatchEvent(new Event("change", { bubbles: true }));
      aF.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    const end = portalAddCalendarDays(start, spanDays);
    portalSetDateOnSelectElements(dF, mF, aF, end);
  }

  function onInicioChange() {
    syncOne();
  }

  const bind = function () {
    const dIn = diaIn();
    const mIn = mesIn();
    const aIn = anioIn();
    if (!dIn || !mIn || !aIn) return;
    dIn.addEventListener("change", onInicioChange);
    mIn.addEventListener("change", onInicioChange);
    aIn.addEventListener("change", onInicioChange);
  };
  bind();

  portalFechaFinPairSyncers.push(syncOne);
}

function syncAllPortalFechaFinDerivadas() {
  portalFechaFinPairSyncers.forEach(function (fn) {
    try {
      fn();
    } catch (e) {
      /* ignore */
    }
  });
}

function applyFiltersPortalLocalFechaSync() {
  const role =
    state.currentRole || window.sessionStorage.getItem("vacaciones_role");
  if (role !== "local") return;
  syncPortalDiasDisponiblesLabels();
  syncAllPortalFechaFinDerivadas();
  // La tabla de ausencias muestra días disponibles leyendo localStorage al renderizar;
  // sin re-render la columna queda obsoleta tras restablecer saldo desde maestroop.
  renderAbsencesTable();
  syncPortalVacationSaldoRestanteLine(
    window.sessionStorage.getItem("vacaciones_operator_id") || ""
  );
}

let __portalSaldoPollLastOid = null;
let __portalSaldoPollLastSaldo;

function portalRefreshLocalVacationSaldoUIForOperator(oid) {
  const role = window.sessionStorage.getItem("vacaciones_role");
  if (role !== "local" || !oid) return;
  const id = String(oid).trim();
  applyFiltersPortalLocalFechaSync();
  applyFilters();
  __portalSaldoPollLastSaldo = getPortalVacationSaldoRestante(id);
}

function portalPollLocalVacationSaldoIfChanged() {
  const role = window.sessionStorage.getItem("vacaciones_role");
  if (role !== "local") return;
  const oid = (window.sessionStorage.getItem("vacaciones_operator_id") || "").trim();
  if (!oid) return;
  if (__portalSaldoPollLastOid !== oid) {
    __portalSaldoPollLastOid = oid;
    __portalSaldoPollLastSaldo = undefined;
  }
  const saldo = getPortalVacationSaldoRestante(oid);
  if (__portalSaldoPollLastSaldo === undefined) {
    __portalSaldoPollLastSaldo = saldo;
    return;
  }
  if (__portalSaldoPollLastSaldo !== saldo) {
    portalRefreshLocalVacationSaldoUIForOperator(oid);
  }
}

function updateAdminOperatorPhotoCardVisibility() {
  const card = document.getElementById("adminOperatorPhotoCard");
  if (!card) return;
  const show = state.filtered && state.filtered.length ? true : false;
  card.style.display = show ? "block" : "none";
  if (show) {
    const opId = getCurrentOperatorIdForPhoto();
    if (opId) renderOperatorPhotoFromStorage(opId);
  }

  // También ocultar la tabla del operador si no hay selección
  const wrap = document.getElementById("adminOperatorDetailWrap");
  if (wrap) {
    wrap.style.display = show ? "block" : "none";
  }

  const historySection = document.getElementById("adminHistorySection");
  if (historySection) {
    historySection.style.display = show ? "block" : "none";
  }
  if (!show) {
    const historyContent = document.getElementById("adminHistoryContent");
    if (historyContent) historyContent.style.display = "none";
    const historyBtn = document.getElementById("adminHistoryToggleBtn");
    if (historyBtn) historyBtn.setAttribute("aria-expanded", "false");
  }

  // Card de resumen + estatus del permiso (solo admin.html)
  const savedEstatusWrap = document.getElementById("adminSavedEstatusWrap");
  if (savedEstatusWrap) {
    savedEstatusWrap.style.display = show ? "flex" : "none";
  }

  const roleForEstatus =
    state.currentRole || window.sessionStorage.getItem("vacaciones_role");
  if (
    (roleForEstatus === "admin" || roleForEstatus === "maestro") &&
    document.getElementById("estatusPermisoBlock")
  ) {
    const oid =
      state.filtered && state.filtered.length === 1
        ? String(state.filtered[0].id)
        : "";
    refreshPortalPermisoStatusUI(oid);
    updateEstatusPermisoActionButtonsState();
  }

  // También ocultar el recuadro "Motivo de ausencia" si no hay selección
  const motivoSection = document.getElementById("motivoSection");
  if (motivoSection) {
    motivoSection.style.display = show ? "block" : "none";
  }

  // operatorDetailContent lo deja vacío renderOperatorsTable() cuando no hay
  // selección (admin/maestro: solo ID 1001–1500 de 4 dígitos).

  // Limpieza extra por si quedó alguna tabla residual en Motivo de ausencia
  const absencesTbody = document.getElementById("absencesTableBody");
  if (absencesTbody && !show) {
    absencesTbody.innerHTML = "";
  }

  // Si el usuario tiene expandido el historial, refrescarlo cuando cambie la selección.
  maybeRenderAdminRequestHistory();
}

function getLastSavedPayloadFromOperator(opId) {
  if (!opId) return null;
  const modeKey = `vacaciones_last_saved_locked_mode_${String(opId)}`;
  const payloadKey = `vacaciones_last_saved_payload_${String(opId)}`;
  const mode = window.localStorage.getItem(modeKey);
  const payloadRaw = window.localStorage.getItem(payloadKey);
  if (mode !== "1" || !payloadRaw) return null;
  try {
    const payload = JSON.parse(payloadRaw);
    return payload && typeof payload === "object" ? payload : null;
  } catch (e) {
    return null;
  }
}

function getAdminRequestHistory(opId) {
  if (!opId) return [];
  const key = adminRequestHistoryStorageKey(String(opId));
  const raw = window.localStorage.getItem(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function setAdminRequestHistory(opId, historyArr) {
  if (!opId) return;
  try {
    window.localStorage.setItem(
      adminRequestHistoryStorageKey(String(opId)),
      JSON.stringify(historyArr)
    );
  } catch (e) {
    /* ignore */
  }
}

function latestHistoryEntryIndex(history) {
  let bestI = 0;
  let bestTs = -Infinity;
  for (let i = 0; i < history.length; i++) {
    const t = history[i] && history[i].ts ? history[i].ts : 0;
    if (t > bestTs || (t === bestTs && i > bestI)) {
      bestTs = t;
      bestI = i;
    }
  }
  return bestI;
}

/** Índice de la fila más reciente solo entre entradas de un mismo operador (admin «todos»). */
function latestHistoryEntryIndexForOperator(history, operatorId) {
  const id = String(operatorId || "").trim();
  let bestI = -1;
  let bestTs = -Infinity;
  for (let i = 0; i < history.length; i++) {
    const e = history[i];
    const oid =
      e && e.operatorId != null && String(e.operatorId).trim() !== ""
        ? String(e.operatorId).trim()
        : "";
    if (oid !== id) continue;
    const t = e && e.ts ? e.ts : 0;
    if (t > bestTs || (t === bestTs && i > bestI)) {
      bestTs = t;
      bestI = i;
    }
  }
  if (bestI < 0) return latestHistoryEntryIndex(history);
  return bestI;
}

/**
 * Estatus de la solicitud más reciente según permiso en localStorage.
 * Si no hay `vacaciones_permiso_status_*` persistido, devuelve null (el historial no debe
 * inferirse del objeto por defecto "todo pendiente": tras reset maestro / borrado de permiso
 * debe poder quedar «Archivada» / aprobado / rechazado guardados en la última fila).
 */
function computeHistorialEstadoForLatestEntry(opId) {
  const id = String(opId || "").trim();
  if (!id) return "pendiente";
  const raw = window.localStorage.getItem(permisoStatusStorageKey(id));
  if (raw == null || String(raw).trim() === "") {
    return null;
  }
  const s = withComputedEstatusFinal(getPermisoStatus(id));
  const v = normalizePermisoRowValue(s.estatusFinal);
  if (v === "aprobado") return "aprobado";
  if (v === "rechazado") return "rechazado";
  return "pendiente";
}

/** Normaliza el texto guardado en historial (evita que «Archivada» o variantes no coincidan con "na"). */
function normalizeHistorialEstadoStored(val) {
  if (val == null) return "";
  const s = String(val).trim().toLowerCase();
  if (s === "aprobado") return "aprobado";
  if (s === "rechazado") return "rechazado";
  if (s === "pendiente") return "pendiente";
  if (s === "na" || s === "n/a" || s === "archivada") return "na";
  return "";
}

/** JSON/localStorage a veces serializa el booleano de forma distinta. */
function isMaestroArchivadaMarker(entry) {
  if (!entry) return false;
  const m = entry.maestroResetArchivada;
  return m === true || m === 1 || m === "true" || m === "1";
}

/**
 * Si la fila visible viene de Firestore sin marcador, pero el último registro local
 * del operador sí tiene archivo por maestro, el estado mostrado debe ser Archivada.
 */
function entryOrLocalLatestHasMaestroArchivada(opId, entry) {
  if (entry && isMaestroArchivadaMarker(entry)) return true;
  const id = String(opId || "").trim();
  if (!id || id === "global") return false;
  const h = getAdminRequestHistory(id);
  if (!h.length) return false;
  const li = latestHistoryEntryIndex(h);
  return isMaestroArchivadaMarker(h[li]);
}

/**
 * Cuando no hay contexto local (cookies/datos borrados), no debemos recalcular estados
 * a Archivada para filas que vienen de Firestore: se respeta lo que trae la nube.
 */
function hasLocalHistorialStateForOperator(opId) {
  const id = String(opId || "").trim();
  if (!id || id === "global") return false;
  try {
    if (getAdminRequestHistory(id).length) return true;
  } catch (e) {
    /* ignore */
  }
  const permisoRaw = window.localStorage.getItem(permisoStatusStorageKey(id));
  if (permisoRaw != null && String(permisoRaw).trim() !== "") return true;
  if (operatorHasValidSavedRequestInStorage(id)) return true;
  return false;
}

/**
 * Estado de la solicitud más reciente (misma regla que syncAdminRequestHistoryEstados
 * para la última fila): permiso en localStorage, borrador guardado, reset maestro, etc.
 * Sirve para historial mezclado con Firestore sin confiar en status remoto desactualizado.
 */
function resolveLatestHistorialEstadoForDisplay(opId, latestEntry) {
  if (
    latestEntry &&
    latestEntry.fromFirestore &&
    !hasLocalHistorialStateForOperator(opId)
  ) {
    const remoteNorm = normalizeHistorialEstadoStored(
      latestEntry.estadoHistorial
    );
    if (
      remoteNorm === "aprobado" ||
      remoteNorm === "rechazado" ||
      remoteNorm === "pendiente" ||
      remoteNorm === "na"
    ) {
      return remoteNorm;
    }
    return "pendiente";
  }

  const leNorm = normalizeHistorialEstadoStored(
    latestEntry && latestEntry.estadoHistorial
  );

  let latestEstado;
  if (entryOrLocalLatestHasMaestroArchivada(opId, latestEntry)) {
    latestEstado = "na";
  } else {
    latestEstado = computeHistorialEstadoForLatestEntry(opId);
    if (leNorm === "na") {
      if (latestEstado !== "aprobado" && latestEstado !== "rechazado") {
        latestEstado = "na";
      }
    } else if (latestEstado === null) {
      const hasSaved = operatorHasValidSavedRequestInStorage(opId);
      if (
        !hasSaved &&
        (leNorm === "pendiente" || leNorm === "")
      ) {
        latestEstado = "na";
      } else if (
        leNorm === "aprobado" ||
        leNorm === "rechazado" ||
        leNorm === "pendiente" ||
        leNorm === "na"
      ) {
        latestEstado = leNorm;
      } else {
        latestEstado = "pendiente";
      }
    } else if (
      latestEstado === "pendiente" &&
      latestEntry &&
      (leNorm === "aprobado" ||
        leNorm === "rechazado" ||
        leNorm === "na")
    ) {
      latestEstado = leNorm;
    }
  }

  if (
    latestEstado === "aprobado" ||
    latestEstado === "rechazado" ||
    latestEstado === "pendiente" ||
    latestEstado === "na"
  ) {
    return latestEstado;
  }
  return "pendiente";
}

/**
 * Persiste estadoHistorial: la más reciente = aprobado | rechazado | pendiente según permiso.
 * Entradas anteriores: si ya quedaron aprobadas/rechazadas, conservar ese valor (no forzar N/A);
 * el resto sigue como na (versiones viejas de una solicitud en trámite).
 */
function syncAdminRequestHistoryEstados(opId) {
  if (!opId || String(opId) === "global") return;
  const history = getAdminRequestHistory(opId);
  if (!history.length) return;

  const latestIdx = latestHistoryEntryIndex(history);
  const latestEntry = history[latestIdx];
  const latestEstado = resolveLatestHistorialEstadoForDisplay(opId, latestEntry);

  const updated = history.map((entry, idx) => {
    if (idx === latestIdx) {
      return { ...entry, estadoHistorial: latestEstado };
    }
    const prev = entry && entry.estadoHistorial;
    if (prev === "aprobado" || prev === "rechazado") {
      return { ...entry, estadoHistorial: prev };
    }
    return { ...entry, estadoHistorial: "na" };
  });

  setAdminRequestHistory(opId, updated);
}

/**
 * Tras borrar cookies / datos del sitio o perder el respaldo guardado: si ya no hay
 * solicitud persistida válida pero el historial sigue con la última fila en trámite,
 * dejarla como Archivada (na). No sustituye aprobado/rechazado ni filas ya archivadas.
 */
function reconcileHistoryArchivadaWhenSavedSolicitudMissing(opId) {
  const id = String(opId || "").trim();
  if (!id || id === "global") return;
  syncAdminRequestHistoryEstados(id);
  if (operatorHasValidSavedRequestInStorage(id)) return;
  const history = getAdminRequestHistory(id);
  if (!history.length) return;
  const latestIdx = latestHistoryEntryIndex(history);
  const latest = history[latestIdx];
  if (isMaestroArchivadaMarker(latest)) return;
  const leNorm = normalizeHistorialEstadoStored(latest && latest.estadoHistorial);
  if (
    leNorm === "aprobado" ||
    leNorm === "rechazado" ||
    leNorm === "na"
  ) {
    return;
  }
  const updated = history.map(function (entry, idx) {
    if (idx === latestIdx) {
      return Object.assign({}, entry, { estadoHistorial: "na" });
    }
    const prev = entry && entry.estadoHistorial;
    if (prev === "aprobado" || prev === "rechazado") {
      return Object.assign({}, entry, { estadoHistorial: prev });
    }
    return Object.assign({}, entry, { estadoHistorial: "na" });
  });
  setAdminRequestHistory(id, updated);
}

function renderHistorialEstadoPillHtml(estado) {
  const e =
    estado === "aprobado" ||
    estado === "rechazado" ||
    estado === "pendiente" ||
    estado === "na"
      ? estado
      : "na";
  if (e === "aprobado") {
    return '<span class="admin-history-item-approved">Aprobado</span>';
  }
  if (e === "rechazado") {
    return '<span class="admin-history-item-rejected">Rechazado</span>';
  }
  if (e === "pendiente") {
    return '<span class="admin-history-item-pendiente">Pendiente</span>';
  }
  return '<span class="admin-history-item-na">Archivada</span>';
}

/**
 * Estado de píldora en historial (portal/admin/PDF). Filas que no son la más reciente
 * quedan Archivadas salvo que ya fueran aprobadas/rechazadas; la más reciente usa la
 * misma lógica que sync (permiso, borrador, maestro), también para filas solo en Firestore.
 * @param {{ historialMultiOp?: boolean }} [options] — listado admin mezclando varios operadores.
 */
function computeEstadoForHistoryEntry(opId, entry, idx, history, options) {
  options = options || {};
  if (!entry) return "na";
  const noLocalState =
    entry.fromFirestore && !hasLocalHistorialStateForOperator(opId);

  let latestIdxInView;
  if (options.historialMultiOp) {
    const oid =
      entry.operatorId != null && String(entry.operatorId).trim() !== ""
        ? String(entry.operatorId).trim()
        : String(opId || "").trim();
    latestIdxInView = latestHistoryEntryIndexForOperator(history, oid);
  } else {
    latestIdxInView = latestHistoryEntryIndex(history);
  }

  if (idx !== latestIdxInView) {
    if (noLocalState) {
      const remoteNorm = normalizeHistorialEstadoStored(entry.estadoHistorial);
      if (
        remoteNorm === "aprobado" ||
        remoteNorm === "rechazado" ||
        remoteNorm === "pendiente" ||
        remoteNorm === "na"
      ) {
        return remoteNorm;
      }
      return "pendiente";
    }
    if (isMaestroArchivadaMarker(entry)) return "na";
    const e = normalizeHistorialEstadoStored(entry.estadoHistorial);
    if (e === "aprobado" || e === "rechazado") return e;
    return "na";
  }

  const permisoOpId =
    entry.operatorId != null && String(entry.operatorId).trim() !== ""
      ? String(entry.operatorId).trim()
      : String(opId || "").trim();
  return resolveLatestHistorialEstadoForDisplay(permisoOpId, entry);
}

function estadoPdfLabel(estado) {
  if (estado === "aprobado") return "Aprobado";
  if (estado === "rechazado") return "Rechazado";
  if (estado === "pendiente") return "Pendiente";
  return "Archivada";
}

/**
 * @param {{ forPdf?: boolean }} [options] — forPdf: solo para PDF, en «Fechas a justificar» usa « - » entre fechas (en pantalla se usa « a »).
 */
function renderAdminRequestDetailsHtmlFromPayload(payload, options) {
  options = options || {};
  const motive = payload && payload.motive ? String(payload.motive) : "Sin motivo";
  const values =
    payload && payload.values && typeof payload.values === "object"
      ? payload.values
      : {};

  const getValue = (id) => {
    const v = values[id];
    return typeof v === "string" ? v.trim() : "";
  };

  const formatDate = (dayId, monthId, yearId) => {
    const d = getValue(dayId);
    const m = getValue(monthId);
    const y = getValue(yearId);
    if (!d || !m || !y) return "No disponible";
    return `${d}/${m}/${y}`;
  };

  let detailsHtml = "";
  if (motive === "Vacaciones") {
    const dias = getValue("diasSolicitadosInput") || "No disponible";
    const inicio = formatDate("fechaDiaSelect", "fechaMesSelect", "fechaAnioSelect");
    const fin = formatDate(
      "fechaDiaSelectFin",
      "fechaMesSelectFin",
      "fechaAnioSelectFin"
    );
    detailsHtml = `
      <div><strong>No. días:</strong> ${escapeHtml(dias)}</div>
      <div><strong>Fechas a disfrutar:</strong> ${escapeHtml(inicio)} a ${escapeHtml(fin)}</div>
    `;
  } else if (motive === "Falta justificada") {
    const diasFj =
      getValue("diasSolicitadosFaltaJustificadaInput") || "No disponible";
    const inicio = formatDate(
      "fechaJustificarDiaSelect",
      "fechaJustificarMesSelect",
      "fechaJustificarAnioSelect"
    );
    const fin = formatDate(
      "fechaJustificarDiaSelectFin",
      "fechaJustificarMesSelectFin",
      "fechaJustificarAnioSelectFin"
    );
    const motivoTexto = getValue("motivoFaltaJustificadaInput") || "No disponible";
    const fjSep = options.forPdf ? " - " : " a ";
    detailsHtml = `
      <div><strong>No. días:</strong> ${escapeHtml(diasFj)}</div>
      <div><strong>Fechas a justificar:</strong> ${escapeHtml(inicio)}${fjSep}${escapeHtml(fin)}</div>
      <div><strong>Motivo:</strong> ${escapeHtml(motivoTexto)}</div>
    `;
  } else if (motive === "Permiso sin goce") {
    const diasSg =
      getValue("diasSolicitadosPermisoSinGoceInput") || "No disponible";
    const inicio = formatDate(
      "fechaPermisoSinGoceDiaSelect",
      "fechaPermisoSinGoceMesSelect",
      "fechaPermisoSinGoceAnioSelect"
    );
    const fin = formatDate(
      "fechaPermisoSinGoceDiaSelectFin",
      "fechaPermisoSinGoceMesSelectFin",
      "fechaPermisoSinGoceAnioSelectFin"
    );
    const motivoTexto = getValue("motivoPermisoSinGoceInput") || "No disponible";
    detailsHtml = `
      <div><strong>No. días:</strong> ${escapeHtml(diasSg)}</div>
      <div><strong>Fechas del permiso:</strong> ${escapeHtml(inicio)} a ${escapeHtml(fin)}</div>
      <div><strong>Motivo:</strong> ${escapeHtml(motivoTexto)}</div>
    `;
  } else if (motive === "Permiso con goce") {
    const tipoPermiso = getValue("permisoGoceSelect") || "No disponible";
    const diasPg =
      getValue("diasSolicitadosPermisoGoceInput") || "No disponible";
    const inicio = formatDate(
      "fechaPermisoDiaSelect",
      "fechaPermisoMesSelect",
      "fechaPermisoAnioSelect"
    );
    const fin = formatDate(
      "fechaPermisoDiaSelectFin",
      "fechaPermisoMesSelectFin",
      "fechaPermisoAnioSelectFin"
    );
    detailsHtml = `
      <div><strong>Tipo de permiso:</strong> ${escapeHtml(tipoPermiso)}</div>
      <div><strong>No. días:</strong> ${escapeHtml(diasPg)}</div>
      <div><strong>Fechas del permiso:</strong> ${escapeHtml(inicio)} a ${escapeHtml(fin)}</div>
    `;
  } else {
    detailsHtml = "<div><strong>Detalle:</strong> Sin formato para este motivo.</div>";
  }

  return `
    <div><strong>Motivo de ausencia:</strong> ${escapeHtml(motive)}</div>
    ${detailsHtml}
  `;
}

function resolveHistoryFooterOperatorNombre(opId) {
  if (!opId) return "";
  const op =
    state.filtered && state.filtered.length === 1 ? state.filtered[0] : null;
  if (op && String(op.id) === String(opId)) {
    return op.nombreCompleto ? String(op.nombreCompleto) : "";
  }
  if (
    isPortalHtmlPage() &&
    state.operators &&
    state.operators.length
  ) {
    const found = state.operators.find((o) => String(o.id) === String(opId));
    if (found && found.nombreCompleto) return String(found.nombreCompleto);
  }
  return "";
}

/**
 * Una línea de texto para la columna «Resumen» del historial en tabla (portal).
 */
function buildPortalHistorySummaryTextFromPayload(payload) {
  const motive = payload && payload.motive ? String(payload.motive) : "Sin motivo";
  const values =
    payload && payload.values && typeof payload.values === "object"
      ? payload.values
      : {};
  const getValue = (id) => {
    const v = values[id];
    return typeof v === "string" ? v.trim() : "";
  };
  const formatDate = (dayId, monthId, yearId) => {
    const d = getValue(dayId);
    const m = getValue(monthId);
    const y = getValue(yearId);
    if (!d || !m || !y) return "—";
    return `${d}/${m}/${y}`;
  };
  if (motive === "Vacaciones") {
    const dias = getValue("diasSolicitadosInput") || "—";
    const inicio = formatDate("fechaDiaSelect", "fechaMesSelect", "fechaAnioSelect");
    const fin = formatDate(
      "fechaDiaSelectFin",
      "fechaMesSelectFin",
      "fechaAnioSelectFin"
    );
    return `${dias} días · ${inicio} – ${fin}`;
  }
  if (motive === "Falta justificada") {
    const diasFj =
      getValue("diasSolicitadosFaltaJustificadaInput") || "—";
    const inicio = formatDate(
      "fechaJustificarDiaSelect",
      "fechaJustificarMesSelect",
      "fechaJustificarAnioSelect"
    );
    const fin = formatDate(
      "fechaJustificarDiaSelectFin",
      "fechaJustificarMesSelectFin",
      "fechaJustificarAnioSelectFin"
    );
    return `${diasFj} días · ${inicio} – ${fin}`;
  }
  if (motive === "Permiso sin goce") {
    const diasSg =
      getValue("diasSolicitadosPermisoSinGoceInput") || "—";
    const inicio = formatDate(
      "fechaPermisoSinGoceDiaSelect",
      "fechaPermisoSinGoceMesSelect",
      "fechaPermisoSinGoceAnioSelect"
    );
    const fin = formatDate(
      "fechaPermisoSinGoceDiaSelectFin",
      "fechaPermisoSinGoceMesSelectFin",
      "fechaPermisoSinGoceAnioSelectFin"
    );
    return `${diasSg} días · ${inicio} – ${fin}`;
  }
  if (motive === "Permiso con goce") {
    const tipoPermiso = getValue("permisoGoceSelect") || "—";
    const diasPg =
      getValue("diasSolicitadosPermisoGoceInput") || "—";
    const inicio = formatDate(
      "fechaPermisoDiaSelect",
      "fechaPermisoMesSelect",
      "fechaPermisoAnioSelect"
    );
    const fin = formatDate(
      "fechaPermisoDiaSelectFin",
      "fechaPermisoMesSelectFin",
      "fechaPermisoAnioSelectFin"
    );
    return `${tipoPermiso} · ${diasPg} días · ${inicio} – ${fin}`;
  }
  return "—";
}

/**
 * Historial local + filas ya traídas de Firestore para este operador (sin ordenar).
 */
function resolveMergedOperatorHistoryEntries(opId) {
  if (!opId) return [];
  syncAdminRequestHistoryEstados(opId);
  let local = getAdminRequestHistory(opId);
  const remote =
    (window.__firestoreHistorialByOperator &&
      window.__firestoreHistorialByOperator[String(opId)]) ||
    [];
  if (!local.length && !remote.length) {
    const lastPayload = getLastSavedPayloadFromOperator(opId);
    if (lastPayload) {
      local = [
        {
          ts: Date.now(),
          tipo: "Solicitud",
          payload: lastPayload,
          estadoHistorial:
            computeHistorialEstadoForLatestEntry(opId) || "pendiente",
        },
      ];
    }
  }
  if (local.length && remote.length) {
    local = local.map(function (e) {
      return attachFirestoreFolioFromRemoteForEntry(e, remote);
    });
  }
  const merged = mergeHistoryEntriesPreferFirestore(local, remote);
  merged.forEach(backfillSolicitudFirestoreStatusIfNeeded);
  return merged;
}

/** Historial del operador para portal (tabla / bandas / futuros), ordenado por fecha descendente. */
function resolvePortalOperatorHistoryEntriesSorted(opId) {
  if (!opId) return [];
  const merged = resolveMergedOperatorHistoryEntries(opId);
  merged.sort(
    (a, b) => (b && b.ts ? b.ts : 0) - (a && a.ts ? a.ts : 0)
  );
  return merged;
}

/**
 * portal.html — Diseño 4: bandas compactas (mismos datos que la tabla).
 */
function buildPortalRequestHistoryRowsHtml(opId) {
  const history = resolvePortalOperatorHistoryEntriesSorted(opId);
  if (!history.length) return "";

  const opNombre = resolveHistoryFooterOperatorNombre(opId);
  const items = history
    .map((entry, idx) => {
      const ts = entry && entry.ts ? new Date(entry.ts) : null;
      const tsText = ts ? ts.toLocaleString() : "";
      const tipoRaw = entry && entry.tipo ? String(entry.tipo) : "";
      const tipo =
        tipoRaw === "Solicitud guardada" || tipoRaw === "Modificación"
          ? "Solicitud"
          : tipoRaw || "Solicitud";
      const payload = entry && entry.payload ? entry.payload : {};
      const motive =
        payload && payload.motive ? String(payload.motive) : "—";
      const summary = buildPortalHistorySummaryTextFromPayload(payload);
      const estado = computeEstadoForHistoryEntry(opId, entry, idx, history);
      const statusPill = renderHistorialEstadoPillHtml(estado);
      const pdfBtn =
        opNombre
          ? `<button type="button" class="admin-history-item-pdf-btn portal-history-row-pdf-btn" data-history-op-id="${escapeHtml(String(opId))}" data-history-ts="${entry && entry.ts ? escapeHtml(String(entry.ts)) : ""}">Generar PDF</button>`
          : "";
      return `<article class="portal-history-row" role="listitem">
        <div class="portal-history-row-body">
          <div class="portal-history-row-head">
            <time class="portal-history-row-date" datetime="${ts ? escapeHtml(ts.toISOString()) : ""}">${escapeHtml(tsText)}</time>
            <span class="portal-history-row-tipo">${escapeHtml(tipo)}</span>
            <span class="portal-history-row-motive">${escapeHtml(motive)}</span>
          </div>
          <p class="portal-history-row-summary">${escapeHtml(summary)}</p>
        </div>
        <div class="portal-history-row-side">
          <div class="portal-history-row-status">${statusPill}</div>
          <div class="portal-history-row-pdf">${pdfBtn}</div>
        </div>
      </article>`;
    })
    .join("");

  return `<div class="portal-history-rows" role="list">${items}</div>`;
}

/**
 * portal.html — Diseño 5: rejilla de mini-tarjetas (mismos datos que la tabla).
 */
function buildPortalRequestHistoryGridHtml(opId) {
  const history = resolvePortalOperatorHistoryEntriesSorted(opId);
  if (!history.length) return "";

  const opNombre = resolveHistoryFooterOperatorNombre(opId);
  const items = history
    .map((entry, idx) => {
      const ts = entry && entry.ts ? new Date(entry.ts) : null;
      const tsText = ts ? ts.toLocaleString() : "";
      const tipoRaw = entry && entry.tipo ? String(entry.tipo) : "";
      const tipo =
        tipoRaw === "Solicitud guardada" || tipoRaw === "Modificación"
          ? "Solicitud"
          : tipoRaw || "Solicitud";
      const payload = entry && entry.payload ? entry.payload : {};
      const motive =
        payload && payload.motive ? String(payload.motive) : "—";
      const summary = buildPortalHistorySummaryTextFromPayload(payload);
      const estado = computeEstadoForHistoryEntry(opId, entry, idx, history);
      const statusPill = renderHistorialEstadoPillHtml(estado);
      const pdfBtn =
        opNombre
          ? `<button type="button" class="admin-history-item-pdf-btn portal-history-grid-pdf-btn" data-history-op-id="${escapeHtml(String(opId))}" data-history-ts="${entry && entry.ts ? escapeHtml(String(entry.ts)) : ""}">Generar PDF</button>`
          : "";
      return `<article class="portal-history-grid-card" role="listitem">
        <header class="portal-history-grid-card-head">
          <time class="portal-history-grid-date" datetime="${ts ? escapeHtml(ts.toISOString()) : ""}">${escapeHtml(tsText)}</time>
          <span class="portal-history-grid-tipo">${escapeHtml(tipo)}</span>
        </header>
        <h3 class="portal-history-grid-motive">${escapeHtml(motive)}</h3>
        <p class="portal-history-grid-summary">${escapeHtml(summary)}</p>
        <footer class="portal-history-grid-foot">
          <div class="portal-history-grid-status">${statusPill}</div>
          <div class="portal-history-grid-pdf">${pdfBtn}</div>
        </footer>
      </article>`;
    })
    .join("");

  return `<div class="portal-history-grid" role="list">${items}</div>`;
}

/**
 * portal.html — Diseño 2: fecha tipográfica a la izquierda, detalle a la derecha (--design2 o --split).
 */
function buildPortalRequestHistorySplitHtml(opId) {
  const history = resolvePortalOperatorHistoryEntriesSorted(opId);
  if (!history.length) return "";

  const opNombre = resolveHistoryFooterOperatorNombre(opId);
  const items = history
    .map((entry, idx) => {
      const ts = entry && entry.ts ? new Date(entry.ts) : null;
      const tsText = ts ? ts.toLocaleString() : "";
      const dayNum = ts ? String(ts.getDate()) : "—";
      const monthYear = ts
        ? ts.toLocaleDateString("es-MX", {
            month: "short",
            year: "numeric",
          })
        : "";
      const timeStr = ts
        ? ts.toLocaleTimeString("es-MX", {
            hour: "2-digit",
            minute: "2-digit",
          })
        : "";
      const tipoRaw = entry && entry.tipo ? String(entry.tipo) : "";
      const tipo =
        tipoRaw === "Solicitud guardada" || tipoRaw === "Modificación"
          ? "Solicitud"
          : tipoRaw || "Solicitud";
      const payload = entry && entry.payload ? entry.payload : {};
      const motive =
        payload && payload.motive ? String(payload.motive) : "—";
      const summary = buildPortalHistorySummaryTextFromPayload(payload);
      const estado = computeEstadoForHistoryEntry(opId, entry, idx, history);
      const statusPill = renderHistorialEstadoPillHtml(estado);
      const pdfBtn =
        opNombre
          ? `<button type="button" class="admin-history-item-pdf-btn portal-history-split-pdf-btn" data-history-op-id="${escapeHtml(String(opId))}" data-history-ts="${entry && entry.ts ? escapeHtml(String(entry.ts)) : ""}">Generar PDF</button>`
          : "";
      const ariaLabel = `Registro ${tsText || "—"}. ${motive}.`;
      return `<article class="portal-history-split-item" role="listitem" aria-label="${escapeHtml(ariaLabel)}">
        <aside class="portal-history-split-aside">
          <div class="portal-history-split-day">${escapeHtml(dayNum)}</div>
          <div class="portal-history-split-my">${escapeHtml(monthYear)}</div>
          <div class="portal-history-split-time">${escapeHtml(timeStr)}</div>
        </aside>
        <div class="portal-history-split-main">
          <div class="portal-history-split-meta">
            <span class="portal-history-split-tipo">${escapeHtml(tipo)}</span>
            <span class="portal-history-split-motive">${escapeHtml(motive)}</span>
          </div>
          <p class="portal-history-split-summary">${escapeHtml(summary)}</p>
          <div class="portal-history-split-actions">
            <div class="portal-history-split-status">${statusPill}</div>
            <div class="portal-history-split-pdf">${pdfBtn}</div>
          </div>
        </div>
      </article>`;
    })
    .join("");

  return `<div class="portal-history-split" role="list">${items}</div>`;
}

/**
 * portal.html — Diseño 6: registro tipo libro mayor (referencia, fecha monoespaciada, líneas guía).
 */
function buildPortalRequestHistoryLedgerHtml(opId) {
  const history = resolvePortalOperatorHistoryEntriesSorted(opId);
  if (!history.length) return "";

  const opNombre = resolveHistoryFooterOperatorNombre(opId);
  const items = history
    .map((entry, idx) => {
      const ts = entry && entry.ts ? new Date(entry.ts) : null;
      const tsText = ts ? ts.toLocaleString() : "";
      const tsIso = ts ? ts.toISOString() : "";
      const tipoRaw = entry && entry.tipo ? String(entry.tipo) : "";
      const tipo =
        tipoRaw === "Solicitud guardada" || tipoRaw === "Modificación"
          ? "Solicitud"
          : tipoRaw || "Solicitud";
      const payload = entry && entry.payload ? entry.payload : {};
      const motive =
        payload && payload.motive ? String(payload.motive) : "—";
      const summary = buildPortalHistorySummaryTextFromPayload(payload);
      const estado = computeEstadoForHistoryEntry(opId, entry, idx, history);
      const statusPill = renderHistorialEstadoPillHtml(estado);
      const pdfBtn =
        opNombre
          ? `<button type="button" class="admin-history-item-pdf-btn portal-history-ledger-pdf-btn" data-history-op-id="${escapeHtml(String(opId))}" data-history-ts="${entry && entry.ts ? escapeHtml(String(entry.ts)) : ""}">PDF</button>`
          : "";
      const refNum = String(idx + 1);
      const ariaLabel = `Entrada ${refNum}. ${tsText || "—"}. ${motive}.`;
      return `<article class="portal-history-ledger-item" role="listitem" aria-label="${escapeHtml(ariaLabel)}">
        <div class="portal-history-ledger-ref" aria-hidden="true">${escapeHtml(refNum)}</div>
        <div class="portal-history-ledger-body">
          <div class="portal-history-ledger-head">
            <time class="portal-history-ledger-time" datetime="${escapeHtml(tsIso)}">${escapeHtml(tsText)}</time>
            <span class="portal-history-ledger-tipo">${escapeHtml(tipo)}</span>
          </div>
          <div class="portal-history-ledger-motive">${escapeHtml(motive)}</div>
          <p class="portal-history-ledger-summary">${escapeHtml(summary)}</p>
          <div class="portal-history-ledger-foot">
            <div class="portal-history-ledger-status">${statusPill}</div>
            <div class="portal-history-ledger-pdf">${pdfBtn}</div>
          </div>
        </div>
      </article>`;
    })
    .join("");

  return `<div class="portal-history-ledger" role="list">${items}</div>`;
}

/**
 * portal.html — Diseño 7: hilos tipo conversación (avatar + burbuja).
 */
function buildPortalRequestHistoryThreadHtml(opId) {
  const history = resolvePortalOperatorHistoryEntriesSorted(opId);
  if (!history.length) return "";

  const opNombre = resolveHistoryFooterOperatorNombre(opId);
  const items = history
    .map((entry, idx) => {
      const ts = entry && entry.ts ? new Date(entry.ts) : null;
      const tsText = ts ? ts.toLocaleString() : "";
      const tsIso = ts ? ts.toISOString() : "";
      const tipoRaw = entry && entry.tipo ? String(entry.tipo) : "";
      const tipo =
        tipoRaw === "Solicitud guardada" || tipoRaw === "Modificación"
          ? "Solicitud"
          : tipoRaw || "Solicitud";
      const payload = entry && entry.payload ? entry.payload : {};
      const motive =
        payload && payload.motive ? String(payload.motive) : "—";
      const summary = buildPortalHistorySummaryTextFromPayload(payload);
      const estado = computeEstadoForHistoryEntry(opId, entry, idx, history);
      const statusPill = renderHistorialEstadoPillHtml(estado);
      const pdfBtn =
        opNombre
          ? `<button type="button" class="admin-history-item-pdf-btn portal-history-thread-pdf-btn" data-history-op-id="${escapeHtml(String(opId))}" data-history-ts="${entry && entry.ts ? escapeHtml(String(entry.ts)) : ""}">Generar PDF</button>`
          : "";
      const rawLetter = motive.replace(/\s/g, "").charAt(0);
      const avatarLetter = rawLetter
        ? rawLetter.toLocaleUpperCase("es-MX")
        : "·";
      const ariaLabel = `Mensaje ${idx + 1}. ${tsText || "—"}. ${motive}.`;
      return `<article class="portal-history-thread-item" role="listitem" aria-label="${escapeHtml(ariaLabel)}">
        <div class="portal-history-thread-avatar" aria-hidden="true">${escapeHtml(avatarLetter)}</div>
        <div class="portal-history-thread-bubble">
          <div class="portal-history-thread-meta">
            <time class="portal-history-thread-time" datetime="${escapeHtml(tsIso)}">${escapeHtml(tsText)}</time>
            <span class="portal-history-thread-tipo">${escapeHtml(tipo)}</span>
          </div>
          <div class="portal-history-thread-motive">${escapeHtml(motive)}</div>
          <p class="portal-history-thread-summary">${escapeHtml(summary)}</p>
          <div class="portal-history-thread-foot">
            <div class="portal-history-thread-status">${statusPill}</div>
            <div class="portal-history-thread-pdf">${pdfBtn}</div>
          </div>
        </div>
      </article>`;
    })
    .join("");

  return `<div class="portal-history-thread" role="list">${items}</div>`;
}

/**
 * portal.html — Diseño 8: paneles con cabecera oscura (tipo widget).
 */
function buildPortalRequestHistoryPanelHtml(opId) {
  const history = resolvePortalOperatorHistoryEntriesSorted(opId);
  if (!history.length) return "";

  const opNombre = resolveHistoryFooterOperatorNombre(opId);
  const items = history
    .map((entry, idx) => {
      const ts = entry && entry.ts ? new Date(entry.ts) : null;
      const tsText = ts ? ts.toLocaleString() : "";
      const tsIso = ts ? ts.toISOString() : "";
      const tipoRaw = entry && entry.tipo ? String(entry.tipo) : "";
      const tipo =
        tipoRaw === "Solicitud guardada" || tipoRaw === "Modificación"
          ? "Solicitud"
          : tipoRaw || "Solicitud";
      const payload = entry && entry.payload ? entry.payload : {};
      const motive =
        payload && payload.motive ? String(payload.motive) : "—";
      const summary = buildPortalHistorySummaryTextFromPayload(payload);
      const estado = computeEstadoForHistoryEntry(opId, entry, idx, history);
      const statusPill = renderHistorialEstadoPillHtml(estado);
      const pdfBtn =
        opNombre
          ? `<button type="button" class="admin-history-item-pdf-btn portal-history-panel-pdf-btn" data-history-op-id="${escapeHtml(String(opId))}" data-history-ts="${entry && entry.ts ? escapeHtml(String(entry.ts)) : ""}">Generar PDF</button>`
          : "";
      const ariaLabel = `Solicitud ${idx + 1}. ${tsText || "—"}. ${motive}.`;
      return `<article class="portal-history-panel-card" role="listitem" aria-label="${escapeHtml(ariaLabel)}">
        <header class="portal-history-panel-bar">
          <time class="portal-history-panel-time" datetime="${escapeHtml(tsIso)}">${escapeHtml(tsText)}</time>
          <span class="portal-history-panel-tipo">${escapeHtml(tipo)}</span>
        </header>
        <div class="portal-history-panel-body">
          <h3 class="portal-history-panel-motive">${escapeHtml(motive)}</h3>
          <p class="portal-history-panel-summary">${escapeHtml(summary)}</p>
          <div class="portal-history-panel-foot">
            <div class="portal-history-panel-status">${statusPill}</div>
            <div class="portal-history-panel-pdf">${pdfBtn}</div>
          </div>
        </div>
      </article>`;
    })
    .join("");

  return `<div class="portal-history-panel-stack" role="list">${items}</div>`;
}

/**
 * portal.html — Diseño 9: línea temporal con raíl y puntos.
 */
function buildPortalRequestHistoryRailHtml(opId) {
  const history = resolvePortalOperatorHistoryEntriesSorted(opId);
  if (!history.length) return "";

  const opNombre = resolveHistoryFooterOperatorNombre(opId);
  const items = history
    .map((entry, idx) => {
      const ts = entry && entry.ts ? new Date(entry.ts) : null;
      const tsText = ts ? ts.toLocaleString() : "";
      const tsIso = ts ? ts.toISOString() : "";
      const tipoRaw = entry && entry.tipo ? String(entry.tipo) : "";
      const tipo =
        tipoRaw === "Solicitud guardada" || tipoRaw === "Modificación"
          ? "Solicitud"
          : tipoRaw || "Solicitud";
      const payload = entry && entry.payload ? entry.payload : {};
      const motive =
        payload && payload.motive ? String(payload.motive) : "—";
      const summary = buildPortalHistorySummaryTextFromPayload(payload);
      const estado = computeEstadoForHistoryEntry(opId, entry, idx, history);
      const statusPill = renderHistorialEstadoPillHtml(estado);
      const pdfBtn =
        opNombre
          ? `<button type="button" class="admin-history-item-pdf-btn portal-history-rail-pdf-btn" data-history-op-id="${escapeHtml(String(opId))}" data-history-ts="${entry && entry.ts ? escapeHtml(String(entry.ts)) : ""}">Generar PDF</button>`
          : "";
      const ariaLabel = `Entrada ${idx + 1}. ${tsText || "—"}. ${motive}.`;
      return `<article class="portal-history-rail-item" role="listitem" aria-label="${escapeHtml(ariaLabel)}">
        <div class="portal-history-rail-axis" aria-hidden="true">
          <span class="portal-history-rail-dot"></span>
        </div>
        <div class="portal-history-rail-card">
          <div class="portal-history-rail-meta">
            <time class="portal-history-rail-time" datetime="${escapeHtml(tsIso)}">${escapeHtml(tsText)}</time>
            <span class="portal-history-rail-tipo">${escapeHtml(tipo)}</span>
          </div>
          <div class="portal-history-rail-motive">${escapeHtml(motive)}</div>
          <p class="portal-history-rail-summary">${escapeHtml(summary)}</p>
          <div class="portal-history-rail-foot">
            <div class="portal-history-rail-status">${statusPill}</div>
            <div class="portal-history-rail-pdf">${pdfBtn}</div>
          </div>
        </div>
      </article>`;
    })
    .join("");

  return `<div class="portal-history-rails" role="list">${items}</div>`;
}

/**
 * portal.html — Diseño 10: notas tipo recordatorio (post-it / aviso).
 */
function buildPortalRequestHistoryNoticeHtml(opId) {
  const history = resolvePortalOperatorHistoryEntriesSorted(opId);
  if (!history.length) return "";

  const opNombre = resolveHistoryFooterOperatorNombre(opId);
  const items = history
    .map((entry, idx) => {
      const ts = entry && entry.ts ? new Date(entry.ts) : null;
      const tsText = ts ? ts.toLocaleString() : "";
      const tsIso = ts ? ts.toISOString() : "";
      const tipoRaw = entry && entry.tipo ? String(entry.tipo) : "";
      const tipo =
        tipoRaw === "Solicitud guardada" || tipoRaw === "Modificación"
          ? "Solicitud"
          : tipoRaw || "Solicitud";
      const payload = entry && entry.payload ? entry.payload : {};
      const motive =
        payload && payload.motive ? String(payload.motive) : "—";
      const summary = buildPortalHistorySummaryTextFromPayload(payload);
      const estado = computeEstadoForHistoryEntry(opId, entry, idx, history);
      const statusPill = renderHistorialEstadoPillHtml(estado);
      const pdfBtn =
        opNombre
          ? `<button type="button" class="admin-history-item-pdf-btn portal-history-notice-pdf-btn" data-history-op-id="${escapeHtml(String(opId))}" data-history-ts="${entry && entry.ts ? escapeHtml(String(entry.ts)) : ""}">Generar PDF</button>`
          : "";
      const ariaLabel = `Nota ${idx + 1}. ${tsText || "—"}. ${motive}.`;
      return `<article class="portal-history-notice-item" role="listitem" aria-label="${escapeHtml(ariaLabel)}">
        <div class="portal-history-notice-pin" aria-hidden="true"></div>
        <div class="portal-history-notice-body">
          <div class="portal-history-notice-head">
            <time class="portal-history-notice-time" datetime="${escapeHtml(tsIso)}">${escapeHtml(tsText)}</time>
            <span class="portal-history-notice-tipo">${escapeHtml(tipo)}</span>
          </div>
          <div class="portal-history-notice-motive">${escapeHtml(motive)}</div>
          <p class="portal-history-notice-summary">${escapeHtml(summary)}</p>
          <div class="portal-history-notice-foot">
            <div class="portal-history-notice-status">${statusPill}</div>
            <div class="portal-history-notice-pdf">${pdfBtn}</div>
          </div>
        </div>
      </article>`;
    })
    .join("");

  return `<div class="portal-history-notice-stack" role="list">${items}</div>`;
}

/**
 * portal.html — Diseño 11: lista editorial minimal (solo tipografía y reglas).
 */
function buildPortalRequestHistoryMinimalHtml(opId) {
  const history = resolvePortalOperatorHistoryEntriesSorted(opId);
  if (!history.length) return "";

  const opNombre = resolveHistoryFooterOperatorNombre(opId);
  const items = history
    .map((entry, idx) => {
      const ts = entry && entry.ts ? new Date(entry.ts) : null;
      const tsText = ts ? ts.toLocaleString() : "";
      const tsIso = ts ? ts.toISOString() : "";
      const tipoRaw = entry && entry.tipo ? String(entry.tipo) : "";
      const tipo =
        tipoRaw === "Solicitud guardada" || tipoRaw === "Modificación"
          ? "Solicitud"
          : tipoRaw || "Solicitud";
      const payload = entry && entry.payload ? entry.payload : {};
      const motive =
        payload && payload.motive ? String(payload.motive) : "—";
      const summary = buildPortalHistorySummaryTextFromPayload(payload);
      const estado = computeEstadoForHistoryEntry(opId, entry, idx, history);
      const statusPill = renderHistorialEstadoPillHtml(estado);
      const pdfBtn =
        opNombre
          ? `<button type="button" class="admin-history-item-pdf-btn portal-history-minimal-pdf-btn" data-history-op-id="${escapeHtml(String(opId))}" data-history-ts="${entry && entry.ts ? escapeHtml(String(entry.ts)) : ""}">Generar PDF</button>`
          : "";
      const ariaLabel = `Entrada ${idx + 1}. ${tsText || "—"}. ${motive}.`;
      return `<article class="portal-history-minimal-item" role="listitem" aria-label="${escapeHtml(ariaLabel)}">
        <p class="portal-history-minimal-kicker">
          <span class="portal-history-minimal-tipo">${escapeHtml(tipo)}</span>
          <span class="portal-history-minimal-sep" aria-hidden="true">·</span>
          <time class="portal-history-minimal-time" datetime="${escapeHtml(tsIso)}">${escapeHtml(tsText)}</time>
        </p>
        <h3 class="portal-history-minimal-title">${escapeHtml(motive)}</h3>
        <p class="portal-history-minimal-lede">${escapeHtml(summary)}</p>
        <div class="portal-history-minimal-actions">
          <div class="portal-history-minimal-status">${statusPill}</div>
          <div class="portal-history-minimal-pdf">${pdfBtn}</div>
        </div>
      </article>`;
    })
    .join("");

  return `<div class="portal-history-minimal-stack" role="list">${items}</div>`;
}

/**
 * portal.html — Diseño 12: paneles cristal sobre gradiente (glassmorphism).
 */
function buildPortalRequestHistoryGlassHtml(opId) {
  const history = resolvePortalOperatorHistoryEntriesSorted(opId);
  if (!history.length) return "";

  const opNombre = resolveHistoryFooterOperatorNombre(opId);
  const items = history
    .map((entry, idx) => {
      const ts = entry && entry.ts ? new Date(entry.ts) : null;
      const tsText = ts ? ts.toLocaleString() : "";
      const tsIso = ts ? ts.toISOString() : "";
      const tipoRaw = entry && entry.tipo ? String(entry.tipo) : "";
      const tipo =
        tipoRaw === "Solicitud guardada" || tipoRaw === "Modificación"
          ? "Solicitud"
          : tipoRaw || "Solicitud";
      const payload = entry && entry.payload ? entry.payload : {};
      const motive =
        payload && payload.motive ? String(payload.motive) : "—";
      const summary = buildPortalHistorySummaryTextFromPayload(payload);
      const estado = computeEstadoForHistoryEntry(opId, entry, idx, history);
      const statusPill = renderHistorialEstadoPillHtml(estado);
      const pdfBtn =
        opNombre
          ? `<button type="button" class="admin-history-item-pdf-btn portal-history-glass-pdf-btn" data-history-op-id="${escapeHtml(String(opId))}" data-history-ts="${entry && entry.ts ? escapeHtml(String(entry.ts)) : ""}">Generar PDF</button>`
          : "";
      const ariaLabel = `Registro ${idx + 1}. ${tsText || "—"}. ${motive}.`;
      return `<article class="portal-history-glass-item" role="listitem" aria-label="${escapeHtml(ariaLabel)}">
        <div class="portal-history-glass-inner">
          <div class="portal-history-glass-meta">
            <time class="portal-history-glass-time" datetime="${escapeHtml(tsIso)}">${escapeHtml(tsText)}</time>
            <span class="portal-history-glass-tipo">${escapeHtml(tipo)}</span>
          </div>
          <h3 class="portal-history-glass-motive">${escapeHtml(motive)}</h3>
          <p class="portal-history-glass-summary">${escapeHtml(summary)}</p>
          <div class="portal-history-glass-foot">
            <div class="portal-history-glass-status">${statusPill}</div>
            <div class="portal-history-glass-pdf">${pdfBtn}</div>
          </div>
        </div>
      </article>`;
    })
    .join("");

  return `<div class="portal-history-glass-stack" role="list">${items}</div>`;
}

/**
 * portal.html — Diseño 13: tarjetas corporativas (acento #31305a + verde portal, lectura clara).
 */
function buildPortalRequestHistoryStudioHtml(opId) {
  const history = resolvePortalOperatorHistoryEntriesSorted(opId);
  if (!history.length) return "";

  const opNombre = resolveHistoryFooterOperatorNombre(opId);
  const items = history
    .map((entry, idx) => {
      const ts = entry && entry.ts ? new Date(entry.ts) : null;
      const tsText = ts ? ts.toLocaleString() : "";
      const tsIso = ts ? ts.toISOString() : "";
      const tipoRaw = entry && entry.tipo ? String(entry.tipo) : "";
      const tipo =
        tipoRaw === "Solicitud guardada" || tipoRaw === "Modificación"
          ? "Solicitud"
          : tipoRaw || "Solicitud";
      const payload = entry && entry.payload ? entry.payload : {};
      const motive =
        payload && payload.motive ? String(payload.motive) : "—";
      const summary = buildPortalHistorySummaryTextFromPayload(payload);
      const estado = computeEstadoForHistoryEntry(opId, entry, idx, history);
      const statusPill = renderHistorialEstadoPillHtml(estado);
      const pdfBtn =
        opNombre
          ? `<button type="button" class="admin-history-item-pdf-btn portal-history-studio-pdf-btn" data-history-op-id="${escapeHtml(String(opId))}" data-history-ts="${entry && entry.ts ? escapeHtml(String(entry.ts)) : ""}">Generar PDF</button>`
          : "";
      const ariaLabel = `Solicitud ${idx + 1}. ${tsText || "—"}. ${motive}.`;
      return `<article class="portal-history-studio-card" role="listitem" aria-label="${escapeHtml(ariaLabel)}">
        <header class="portal-history-studio-head">
          <time class="portal-history-studio-time" datetime="${escapeHtml(tsIso)}">${escapeHtml(tsText)}</time>
          <span class="portal-history-studio-tipo">${escapeHtml(tipo)}</span>
        </header>
        <h3 class="portal-history-studio-motive">${escapeHtml(motive)}</h3>
        <p class="portal-history-studio-summary">${escapeHtml(summary)}</p>
        <footer class="portal-history-studio-foot">
          <div class="portal-history-studio-status">${statusPill}</div>
          <div class="portal-history-studio-pdf">${pdfBtn}</div>
        </footer>
      </article>`;
    })
    .join("");

  return `<div class="portal-history-studio" role="list">${items}</div>`;
}

/**
 * portal.html — Diseño 14: rejilla dos columnas (fecha en panel izquierdo, detalle derecha).
 */
function buildPortalRequestHistoryColumnsHtml(opId) {
  const history = resolvePortalOperatorHistoryEntriesSorted(opId);
  if (!history.length) return "";

  const opNombre = resolveHistoryFooterOperatorNombre(opId);
  const items = history
    .map((entry, idx) => {
      const ts = entry && entry.ts ? new Date(entry.ts) : null;
      const tsText = ts ? ts.toLocaleString() : "";
      const dayNum = ts ? String(ts.getDate()) : "—";
      const monthYear = ts
        ? ts.toLocaleDateString("es-MX", {
            month: "short",
            year: "numeric",
          })
        : "";
      const timeStr = ts
        ? ts.toLocaleTimeString("es-MX", {
            hour: "2-digit",
            minute: "2-digit",
          })
        : "";
      const tipoRaw = entry && entry.tipo ? String(entry.tipo) : "";
      const tipo =
        tipoRaw === "Solicitud guardada" || tipoRaw === "Modificación"
          ? "Solicitud"
          : tipoRaw || "Solicitud";
      const payload = entry && entry.payload ? entry.payload : {};
      const motive =
        payload && payload.motive ? String(payload.motive) : "—";
      const summary = buildPortalHistorySummaryTextFromPayload(payload);
      const estado = computeEstadoForHistoryEntry(opId, entry, idx, history);
      const statusPill = renderHistorialEstadoPillHtml(estado);
      const pdfBtn =
        opNombre
          ? `<button type="button" class="admin-history-item-pdf-btn portal-history-columns-pdf-btn" data-history-op-id="${escapeHtml(String(opId))}" data-history-ts="${entry && entry.ts ? escapeHtml(String(entry.ts)) : ""}">Generar PDF</button>`
          : "";
      const ariaLabel = `Solicitud ${idx + 1}. ${tsText || "—"}. ${motive}.`;
      return `<article class="portal-history-columns-item" role="listitem" aria-label="${escapeHtml(ariaLabel)}">
        <aside class="portal-history-columns-aside">
          <div class="portal-history-columns-day">${escapeHtml(dayNum)}</div>
          <div class="portal-history-columns-my">${escapeHtml(monthYear)}</div>
          <div class="portal-history-columns-clock">${escapeHtml(timeStr)}</div>
        </aside>
        <div class="portal-history-columns-main">
          <div class="portal-history-columns-meta">
            <span class="portal-history-columns-tipo">${escapeHtml(tipo)}</span>
          </div>
          <h3 class="portal-history-columns-motive">${escapeHtml(motive)}</h3>
          <p class="portal-history-columns-summary">${escapeHtml(summary)}</p>
          <div class="portal-history-columns-foot">
            <div class="portal-history-columns-status">${statusPill}</div>
            <div class="portal-history-columns-pdf">${pdfBtn}</div>
          </div>
        </div>
      </article>`;
    })
    .join("");

  return `<div class="portal-history-columns" role="list">${items}</div>`;
}

/**
 * portal.html — Diseño 15: expediente / carpeta (hojas sobre fondo manila).
 */
function buildPortalRequestHistoryDossierHtml(opId) {
  const history = resolvePortalOperatorHistoryEntriesSorted(opId);
  if (!history.length) return "";

  const opNombre = resolveHistoryFooterOperatorNombre(opId);
  const items = history
    .map((entry, idx) => {
      const ts = entry && entry.ts ? new Date(entry.ts) : null;
      const tsText = ts ? ts.toLocaleString() : "";
      const tsIso = ts ? ts.toISOString() : "";
      const tipoRaw = entry && entry.tipo ? String(entry.tipo) : "";
      const tipo =
        tipoRaw === "Solicitud guardada" || tipoRaw === "Modificación"
          ? "Solicitud"
          : tipoRaw || "Solicitud";
      const payload = entry && entry.payload ? entry.payload : {};
      const motive =
        payload && payload.motive ? String(payload.motive) : "—";
      const summary = buildPortalHistorySummaryTextFromPayload(payload);
      const estado = computeEstadoForHistoryEntry(opId, entry, idx, history);
      const statusPill = renderHistorialEstadoPillHtml(estado);
      const pdfBtn =
        opNombre
          ? `<button type="button" class="admin-history-item-pdf-btn portal-history-dossier-pdf-btn" data-history-op-id="${escapeHtml(String(opId))}" data-history-ts="${entry && entry.ts ? escapeHtml(String(entry.ts)) : ""}">Generar PDF</button>`
          : "";
      const n = String(idx + 1);
      const ariaLabel = `Expediente ${n}. ${tsText || "—"}. ${motive}.`;
      return `<article class="portal-history-dossier-sheet" role="listitem" aria-label="${escapeHtml(ariaLabel)}">
        <div class="portal-history-dossier-tab" aria-hidden="true">${escapeHtml(n)}</div>
        <div class="portal-history-dossier-body">
          <div class="portal-history-dossier-head">
            <time class="portal-history-dossier-time" datetime="${escapeHtml(tsIso)}">${escapeHtml(tsText)}</time>
            <span class="portal-history-dossier-tipo">${escapeHtml(tipo)}</span>
          </div>
          <h3 class="portal-history-dossier-motive">${escapeHtml(motive)}</h3>
          <p class="portal-history-dossier-summary">${escapeHtml(summary)}</p>
          <div class="portal-history-dossier-foot">
            <div class="portal-history-dossier-status">${statusPill}</div>
            <div class="portal-history-dossier-pdf">${pdfBtn}</div>
          </div>
        </div>
      </article>`;
    })
    .join("");

  return `<div class="portal-history-dossier" role="list">${items}</div>`;
}

/**
 * portal.html — Diseño 16: tarjetas «en relieve» sobre fondo gris (sombra interior).
 */
function buildPortalRequestHistoryInsetHtml(opId) {
  const history = resolvePortalOperatorHistoryEntriesSorted(opId);
  if (!history.length) return "";

  const opNombre = resolveHistoryFooterOperatorNombre(opId);
  const items = history
    .map((entry, idx) => {
      const ts = entry && entry.ts ? new Date(entry.ts) : null;
      const tsText = ts ? ts.toLocaleString() : "";
      const tsIso = ts ? ts.toISOString() : "";
      const tipoRaw = entry && entry.tipo ? String(entry.tipo) : "";
      const tipo =
        tipoRaw === "Solicitud guardada" || tipoRaw === "Modificación"
          ? "Solicitud"
          : tipoRaw || "Solicitud";
      const payload = entry && entry.payload ? entry.payload : {};
      const motive =
        payload && payload.motive ? String(payload.motive) : "—";
      const summary = buildPortalHistorySummaryTextFromPayload(payload);
      const estado = computeEstadoForHistoryEntry(opId, entry, idx, history);
      const statusPill = renderHistorialEstadoPillHtml(estado);
      const pdfBtn =
        opNombre
          ? `<button type="button" class="admin-history-item-pdf-btn portal-history-inset-pdf-btn" data-history-op-id="${escapeHtml(String(opId))}" data-history-ts="${entry && entry.ts ? escapeHtml(String(entry.ts)) : ""}">Generar PDF</button>`
          : "";
      const ariaLabel = `Registro ${idx + 1}. ${tsText || "—"}. ${motive}.`;
      return `<article class="portal-history-inset-card" role="listitem" aria-label="${escapeHtml(ariaLabel)}">
        <header class="portal-history-inset-head">
          <time class="portal-history-inset-time" datetime="${escapeHtml(tsIso)}">${escapeHtml(tsText)}</time>
          <span class="portal-history-inset-tipo">${escapeHtml(tipo)}</span>
        </header>
        <h3 class="portal-history-inset-motive">${escapeHtml(motive)}</h3>
        <p class="portal-history-inset-summary">${escapeHtml(summary)}</p>
        <footer class="portal-history-inset-foot">
          <div class="portal-history-inset-status">${statusPill}</div>
          <div class="portal-history-inset-pdf">${pdfBtn}</div>
        </footer>
      </article>`;
    })
    .join("");

  return `<div class="portal-history-inset-stack" role="list">${items}</div>`;
}

/**
 * portal.html — Diseño 17: variante mint / teal (fondo suave, acento turquesa).
 */
function buildPortalRequestHistoryMintHtml(opId) {
  const history = resolvePortalOperatorHistoryEntriesSorted(opId);
  if (!history.length) return "";

  const opNombre = resolveHistoryFooterOperatorNombre(opId);
  const items = history
    .map((entry, idx) => {
      const ts = entry && entry.ts ? new Date(entry.ts) : null;
      const tsText = ts ? ts.toLocaleString() : "";
      const tsIso = ts ? ts.toISOString() : "";
      const tipoRaw = entry && entry.tipo ? String(entry.tipo) : "";
      const tipo =
        tipoRaw === "Solicitud guardada" || tipoRaw === "Modificación"
          ? "Solicitud"
          : tipoRaw || "Solicitud";
      const payload = entry && entry.payload ? entry.payload : {};
      const motive =
        payload && payload.motive ? String(payload.motive) : "—";
      const summary = buildPortalHistorySummaryTextFromPayload(payload);
      const estado = computeEstadoForHistoryEntry(opId, entry, idx, history);
      const statusPill = renderHistorialEstadoPillHtml(estado);
      const pdfBtn =
        opNombre
          ? `<button type="button" class="admin-history-item-pdf-btn portal-history-mint-pdf-btn" data-history-op-id="${escapeHtml(String(opId))}" data-history-ts="${entry && entry.ts ? escapeHtml(String(entry.ts)) : ""}">Generar PDF</button>`
          : "";
      const ariaLabel = `Solicitud ${idx + 1}. ${tsText || "—"}. ${motive}.`;
      return `<article class="portal-history-mint-card" role="listitem" aria-label="${escapeHtml(ariaLabel)}">
        <header class="portal-history-mint-head">
          <time class="portal-history-mint-time" datetime="${escapeHtml(tsIso)}">${escapeHtml(tsText)}</time>
          <span class="portal-history-mint-tipo">${escapeHtml(tipo)}</span>
        </header>
        <h3 class="portal-history-mint-motive">${escapeHtml(motive)}</h3>
        <p class="portal-history-mint-summary">${escapeHtml(summary)}</p>
        <footer class="portal-history-mint-foot">
          <div class="portal-history-mint-status">${statusPill}</div>
          <div class="portal-history-mint-pdf">${pdfBtn}</div>
        </footer>
      </article>`;
    })
    .join("");

  return `<div class="portal-history-mint" role="list">${items}</div>`;
}

/**
 * portal.html — Diseño 18: catálogo (miniatura con inicial + contenido a la derecha).
 */
function buildPortalRequestHistoryCatalogHtml(opId) {
  const history = resolvePortalOperatorHistoryEntriesSorted(opId);
  if (!history.length) return "";

  const opNombre = resolveHistoryFooterOperatorNombre(opId);
  const items = history
    .map((entry, idx) => {
      const ts = entry && entry.ts ? new Date(entry.ts) : null;
      const tsText = ts ? ts.toLocaleString() : "";
      const tsIso = ts ? ts.toISOString() : "";
      const tipoRaw = entry && entry.tipo ? String(entry.tipo) : "";
      const tipo =
        tipoRaw === "Solicitud guardada" || tipoRaw === "Modificación"
          ? "Solicitud"
          : tipoRaw || "Solicitud";
      const payload = entry && entry.payload ? entry.payload : {};
      const motive =
        payload && payload.motive ? String(payload.motive) : "—";
      const summary = buildPortalHistorySummaryTextFromPayload(payload);
      const estado = computeEstadoForHistoryEntry(opId, entry, idx, history);
      const statusPill = renderHistorialEstadoPillHtml(estado);
      const pdfBtn =
        opNombre
          ? `<button type="button" class="admin-history-item-pdf-btn portal-history-catalog-pdf-btn" data-history-op-id="${escapeHtml(String(opId))}" data-history-ts="${entry && entry.ts ? escapeHtml(String(entry.ts)) : ""}">Generar PDF</button>`
          : "";
      const rawLetter = motive.replace(/\s/g, "").charAt(0);
      const thumbLetter = rawLetter
        ? rawLetter.toLocaleUpperCase("es-MX")
        : "·";
      const ariaLabel = `Ítem ${idx + 1}. ${tsText || "—"}. ${motive}.`;
      return `<article class="portal-history-catalog-item" role="listitem" aria-label="${escapeHtml(ariaLabel)}">
        <div class="portal-history-catalog-thumb" aria-hidden="true">${escapeHtml(thumbLetter)}</div>
        <div class="portal-history-catalog-body">
          <div class="portal-history-catalog-head">
            <time class="portal-history-catalog-time" datetime="${escapeHtml(tsIso)}">${escapeHtml(tsText)}</time>
            <span class="portal-history-catalog-tipo">${escapeHtml(tipo)}</span>
          </div>
          <h3 class="portal-history-catalog-motive">${escapeHtml(motive)}</h3>
          <p class="portal-history-catalog-summary">${escapeHtml(summary)}</p>
          <div class="portal-history-catalog-foot">
            <div class="portal-history-catalog-status">${statusPill}</div>
            <div class="portal-history-catalog-pdf">${pdfBtn}</div>
          </div>
        </div>
      </article>`;
    })
    .join("");

  return `<div class="portal-history-catalog" role="list">${items}</div>`;
}

/**
 * portal.html — Diseño 19: recibo / ticket térmico (monoespaciado, líneas guión).
 */
function buildPortalRequestHistoryReceiptHtml(opId) {
  const history = resolvePortalOperatorHistoryEntriesSorted(opId);
  if (!history.length) return "";

  const opNombre = resolveHistoryFooterOperatorNombre(opId);
  const items = history
    .map((entry, idx) => {
      const ts = entry && entry.ts ? new Date(entry.ts) : null;
      const tsText = ts ? ts.toLocaleString() : "";
      const tsIso = ts ? ts.toISOString() : "";
      const tipoRaw = entry && entry.tipo ? String(entry.tipo) : "";
      const tipo =
        tipoRaw === "Solicitud guardada" || tipoRaw === "Modificación"
          ? "Solicitud"
          : tipoRaw || "Solicitud";
      const payload = entry && entry.payload ? entry.payload : {};
      const motive =
        payload && payload.motive ? String(payload.motive) : "—";
      const summary = buildPortalHistorySummaryTextFromPayload(payload);
      const estado = computeEstadoForHistoryEntry(opId, entry, idx, history);
      const statusPill = renderHistorialEstadoPillHtml(estado);
      const pdfBtn =
        opNombre
          ? `<button type="button" class="admin-history-item-pdf-btn portal-history-receipt-pdf-btn" data-history-op-id="${escapeHtml(String(opId))}" data-history-ts="${entry && entry.ts ? escapeHtml(String(entry.ts)) : ""}">GENERAR PDF</button>`
          : "";
      const n = String(idx + 1).padStart(3, "0");
      const ariaLabel = `Recibo ${n}. ${tsText || "—"}. ${motive}.`;
      return `<article class="portal-history-receipt-sheet" role="listitem" aria-label="${escapeHtml(ariaLabel)}">
        <div class="portal-history-receipt-brand">S A M S O N G</div>
        <div class="portal-history-receipt-rule" aria-hidden="true"></div>
        <div class="portal-history-receipt-row">
          <span class="portal-history-receipt-label">TICKET</span>
          <span class="portal-history-receipt-val">#${escapeHtml(n)}</span>
        </div>
        <div class="portal-history-receipt-row">
          <span class="portal-history-receipt-label">FECHA</span>
          <time class="portal-history-receipt-val" datetime="${escapeHtml(tsIso)}">${escapeHtml(tsText)}</time>
        </div>
        <div class="portal-history-receipt-row">
          <span class="portal-history-receipt-label">TIPO</span>
          <span class="portal-history-receipt-val">${escapeHtml(tipo)}</span>
        </div>
        <div class="portal-history-receipt-rule" aria-hidden="true"></div>
        <div class="portal-history-receipt-motive">${escapeHtml(motive)}</div>
        <p class="portal-history-receipt-summary">${escapeHtml(summary)}</p>
        <div class="portal-history-receipt-rule" aria-hidden="true"></div>
        <div class="portal-history-receipt-row portal-history-receipt-row--status">
          <span class="portal-history-receipt-label">ESTADO</span>
          <span class="portal-history-receipt-statuswrap">${statusPill}</span>
        </div>
        <div class="portal-history-receipt-actions">${pdfBtn}</div>
      </article>`;
    })
    .join("");

  return `<div class="portal-history-receipt-stack" role="list">${items}</div>`;
}

/**
 * portal.html — Diseño 20: marco tipo Polaroid (área oscura + leyenda inferior).
 */
function buildPortalRequestHistoryPolaroidHtml(opId) {
  const history = resolvePortalOperatorHistoryEntriesSorted(opId);
  if (!history.length) return "";

  const opNombre = resolveHistoryFooterOperatorNombre(opId);
  const items = history
    .map((entry, idx) => {
      const ts = entry && entry.ts ? new Date(entry.ts) : null;
      const tsText = ts ? ts.toLocaleString() : "";
      const tsIso = ts ? ts.toISOString() : "";
      const tipoRaw = entry && entry.tipo ? String(entry.tipo) : "";
      const tipo =
        tipoRaw === "Solicitud guardada" || tipoRaw === "Modificación"
          ? "Solicitud"
          : tipoRaw || "Solicitud";
      const payload = entry && entry.payload ? entry.payload : {};
      const motive =
        payload && payload.motive ? String(payload.motive) : "—";
      const summary = buildPortalHistorySummaryTextFromPayload(payload);
      const estado = computeEstadoForHistoryEntry(opId, entry, idx, history);
      const statusPill = renderHistorialEstadoPillHtml(estado);
      const pdfBtn =
        opNombre
          ? `<button type="button" class="admin-history-item-pdf-btn portal-history-polaroid-pdf-btn" data-history-op-id="${escapeHtml(String(opId))}" data-history-ts="${entry && entry.ts ? escapeHtml(String(entry.ts)) : ""}">Generar PDF</button>`
          : "";
      const ariaLabel = `Ficha ${idx + 1}. ${tsText || "—"}. ${motive}.`;
      return `<article class="portal-history-polaroid-card" role="listitem" aria-label="${escapeHtml(ariaLabel)}">
        <div class="portal-history-polaroid-frame">
          <div class="portal-history-polaroid-photo">
            <span class="portal-history-polaroid-motive">${escapeHtml(motive)}</span>
          </div>
          <div class="portal-history-polaroid-caption">
            <div class="portal-history-polaroid-meta">
              <time class="portal-history-polaroid-time" datetime="${escapeHtml(tsIso)}">${escapeHtml(tsText)}</time>
              <span class="portal-history-polaroid-tipo">${escapeHtml(tipo)}</span>
            </div>
            <p class="portal-history-polaroid-summary">${escapeHtml(summary)}</p>
            <div class="portal-history-polaroid-foot">
              <div class="portal-history-polaroid-status">${statusPill}</div>
              <div class="portal-history-polaroid-pdf">${pdfBtn}</div>
            </div>
          </div>
        </div>
      </article>`;
    })
    .join("");

  return `<div class="portal-history-polaroid-stack" role="list">${items}</div>`;
}

/**
 * portal.html — Diseño 21: columna tipo periódico (titular serif + cuerpo).
 */
function buildPortalRequestHistoryJournalHtml(opId) {
  const history = resolvePortalOperatorHistoryEntriesSorted(opId);
  if (!history.length) return "";

  const opNombre = resolveHistoryFooterOperatorNombre(opId);
  const items = history
    .map((entry, idx) => {
      const ts = entry && entry.ts ? new Date(entry.ts) : null;
      const tsText = ts ? ts.toLocaleString() : "";
      const tsIso = ts ? ts.toISOString() : "";
      const tipoRaw = entry && entry.tipo ? String(entry.tipo) : "";
      const tipo =
        tipoRaw === "Solicitud guardada" || tipoRaw === "Modificación"
          ? "Solicitud"
          : tipoRaw || "Solicitud";
      const payload = entry && entry.payload ? entry.payload : {};
      const motive =
        payload && payload.motive ? String(payload.motive) : "—";
      const summary = buildPortalHistorySummaryTextFromPayload(payload);
      const estado = computeEstadoForHistoryEntry(opId, entry, idx, history);
      const statusPill = renderHistorialEstadoPillHtml(estado);
      const pdfBtn =
        opNombre
          ? `<button type="button" class="admin-history-item-pdf-btn portal-history-journal-pdf-btn" data-history-op-id="${escapeHtml(String(opId))}" data-history-ts="${entry && entry.ts ? escapeHtml(String(entry.ts)) : ""}">Generar PDF</button>`
          : "";
      const ariaLabel = `Noticia ${idx + 1}. ${tsText || "—"}. ${motive}.`;
      return `<article class="portal-history-journal-item" role="listitem" aria-label="${escapeHtml(ariaLabel)}">
        <div class="portal-history-journal-rule" aria-hidden="true"></div>
        <h3 class="portal-history-journal-headline">${escapeHtml(motive)}</h3>
        <p class="portal-history-journal-byline">
          <time datetime="${escapeHtml(tsIso)}">${escapeHtml(tsText)}</time>
          <span class="portal-history-journal-sep" aria-hidden="true">·</span>
          <span>${escapeHtml(tipo)}</span>
        </p>
        <p class="portal-history-journal-body">${escapeHtml(summary)}</p>
        <div class="portal-history-journal-foot">
          <div class="portal-history-journal-status">${statusPill}</div>
          <div class="portal-history-journal-pdf">${pdfBtn}</div>
        </div>
      </article>`;
    })
    .join("");

  return `<div class="portal-history-journal" role="list">${items}</div>`;
}

/**
 * portal.html — Diseño 22: lista agrupada estilo iOS (filas con separadores).
 */
function buildPortalRequestHistoryIosHtml(opId) {
  const history = resolvePortalOperatorHistoryEntriesSorted(opId);
  if (!history.length) return "";

  const opNombre = resolveHistoryFooterOperatorNombre(opId);
  const items = history
    .map((entry, idx) => {
      const ts = entry && entry.ts ? new Date(entry.ts) : null;
      const tsText = ts ? ts.toLocaleString() : "";
      const tsIso = ts ? ts.toISOString() : "";
      const tipoRaw = entry && entry.tipo ? String(entry.tipo) : "";
      const tipo =
        tipoRaw === "Solicitud guardada" || tipoRaw === "Modificación"
          ? "Solicitud"
          : tipoRaw || "Solicitud";
      const payload = entry && entry.payload ? entry.payload : {};
      const motive =
        payload && payload.motive ? String(payload.motive) : "—";
      const summary = buildPortalHistorySummaryTextFromPayload(payload);
      const estado = computeEstadoForHistoryEntry(opId, entry, idx, history);
      const statusPill = renderHistorialEstadoPillHtml(estado);
      const pdfBtn =
        opNombre
          ? `<button type="button" class="admin-history-item-pdf-btn portal-history-ios-pdf-btn" data-history-op-id="${escapeHtml(String(opId))}" data-history-ts="${entry && entry.ts ? escapeHtml(String(entry.ts)) : ""}">Generar PDF</button>`
          : "";
      const ariaLabel = `Grupo ${idx + 1}. ${tsText || "—"}. ${motive}.`;
      return `<article class="portal-history-ios-group" role="listitem" aria-label="${escapeHtml(ariaLabel)}">
        <div class="portal-history-ios-row portal-history-ios-row--title">${escapeHtml(motive)}</div>
        <div class="portal-history-ios-row portal-history-ios-row--muted">
          <span class="portal-history-ios-label">Fecha</span>
          <time class="portal-history-ios-value" datetime="${escapeHtml(tsIso)}">${escapeHtml(tsText)}</time>
        </div>
        <div class="portal-history-ios-row portal-history-ios-row--muted">
          <span class="portal-history-ios-label">Tipo</span>
          <span class="portal-history-ios-value">${escapeHtml(tipo)}</span>
        </div>
        <div class="portal-history-ios-row portal-history-ios-row--body">${escapeHtml(summary)}</div>
        <div class="portal-history-ios-row portal-history-ios-row--foot">
          <div class="portal-history-ios-status">${statusPill}</div>
          <div class="portal-history-ios-pdf">${pdfBtn}</div>
        </div>
      </article>`;
    })
    .join("");

  return `<div class="portal-history-ios" role="list">${items}</div>`;
}

/**
 * portal.html — Diseño 23: variante oscura (slate / modo noche).
 */
function buildPortalRequestHistoryNightHtml(opId) {
  const history = resolvePortalOperatorHistoryEntriesSorted(opId);
  if (!history.length) return "";

  const opNombre = resolveHistoryFooterOperatorNombre(opId);
  const items = history
    .map((entry, idx) => {
      const ts = entry && entry.ts ? new Date(entry.ts) : null;
      const tsText = ts ? ts.toLocaleString() : "";
      const tsIso = ts ? ts.toISOString() : "";
      const tipoRaw = entry && entry.tipo ? String(entry.tipo) : "";
      const tipo =
        tipoRaw === "Solicitud guardada" || tipoRaw === "Modificación"
          ? "Solicitud"
          : tipoRaw || "Solicitud";
      const payload = entry && entry.payload ? entry.payload : {};
      const motive =
        payload && payload.motive ? String(payload.motive) : "—";
      const summary = buildPortalHistorySummaryTextFromPayload(payload);
      const estado = computeEstadoForHistoryEntry(opId, entry, idx, history);
      const statusPill = renderHistorialEstadoPillHtml(estado);
      const pdfBtn =
        opNombre
          ? `<button type="button" class="admin-history-item-pdf-btn portal-history-night-pdf-btn" data-history-op-id="${escapeHtml(String(opId))}" data-history-ts="${entry && entry.ts ? escapeHtml(String(entry.ts)) : ""}">Generar PDF</button>`
          : "";
      const ariaLabel = `Registro ${idx + 1}. ${tsText || "—"}. ${motive}.`;
      return `<article class="portal-history-night-card" role="listitem" aria-label="${escapeHtml(ariaLabel)}">
        <header class="portal-history-night-head">
          <time class="portal-history-night-time" datetime="${escapeHtml(tsIso)}">${escapeHtml(tsText)}</time>
          <span class="portal-history-night-tipo">${escapeHtml(tipo)}</span>
        </header>
        <h3 class="portal-history-night-motive">${escapeHtml(motive)}</h3>
        <p class="portal-history-night-summary">${escapeHtml(summary)}</p>
        <footer class="portal-history-night-foot">
          <div class="portal-history-night-status">${statusPill}</div>
          <div class="portal-history-night-pdf">${pdfBtn}</div>
        </footer>
      </article>`;
    })
    .join("");

  return `<div class="portal-history-night" role="list">${items}</div>`;
}

/**
 * portal.html — Diseño 24: neo-brutalismo (amarillo, bordes negros, sombra dura).
 */
function buildPortalRequestHistoryNeoHtml(opId) {
  const history = resolvePortalOperatorHistoryEntriesSorted(opId);
  if (!history.length) return "";

  const opNombre = resolveHistoryFooterOperatorNombre(opId);
  const items = history
    .map((entry, idx) => {
      const ts = entry && entry.ts ? new Date(entry.ts) : null;
      const tsText = ts ? ts.toLocaleString() : "";
      const tsIso = ts ? ts.toISOString() : "";
      const tipoRaw = entry && entry.tipo ? String(entry.tipo) : "";
      const tipo =
        tipoRaw === "Solicitud guardada" || tipoRaw === "Modificación"
          ? "Solicitud"
          : tipoRaw || "Solicitud";
      const payload = entry && entry.payload ? entry.payload : {};
      const motive =
        payload && payload.motive ? String(payload.motive) : "—";
      const summary = buildPortalHistorySummaryTextFromPayload(payload);
      const estado = computeEstadoForHistoryEntry(opId, entry, idx, history);
      const statusPill = renderHistorialEstadoPillHtml(estado);
      const pdfBtn =
        opNombre
          ? `<button type="button" class="admin-history-item-pdf-btn portal-history-neo-pdf-btn" data-history-op-id="${escapeHtml(String(opId))}" data-history-ts="${entry && entry.ts ? escapeHtml(String(entry.ts)) : ""}">PDF</button>`
          : "";
      const ariaLabel = `Bloque ${idx + 1}. ${tsText || "—"}. ${motive}.`;
      return `<article class="portal-history-neo-card" role="listitem" aria-label="${escapeHtml(ariaLabel)}">
        <header class="portal-history-neo-head">
          <time class="portal-history-neo-time" datetime="${escapeHtml(tsIso)}">${escapeHtml(tsText)}</time>
          <span class="portal-history-neo-tipo">${escapeHtml(tipo)}</span>
        </header>
        <h3 class="portal-history-neo-motive">${escapeHtml(motive)}</h3>
        <p class="portal-history-neo-summary">${escapeHtml(summary)}</p>
        <footer class="portal-history-neo-foot">
          <div class="portal-history-neo-status">${statusPill}</div>
          <div class="portal-history-neo-pdf">${pdfBtn}</div>
        </footer>
      </article>`;
    })
    .join("");

  return `<div class="portal-history-neo" role="list">${items}</div>`;
}

/**
 * portal.html — Diseño 25: pastel suave (lavanda / rosa claro).
 */
function buildPortalRequestHistoryPastelHtml(opId) {
  const history = resolvePortalOperatorHistoryEntriesSorted(opId);
  if (!history.length) return "";

  const opNombre = resolveHistoryFooterOperatorNombre(opId);
  const items = history
    .map((entry, idx) => {
      const ts = entry && entry.ts ? new Date(entry.ts) : null;
      const tsText = ts ? ts.toLocaleString() : "";
      const tsIso = ts ? ts.toISOString() : "";
      const tipoRaw = entry && entry.tipo ? String(entry.tipo) : "";
      const tipo =
        tipoRaw === "Solicitud guardada" || tipoRaw === "Modificación"
          ? "Solicitud"
          : tipoRaw || "Solicitud";
      const payload = entry && entry.payload ? entry.payload : {};
      const motive =
        payload && payload.motive ? String(payload.motive) : "—";
      const summary = buildPortalHistorySummaryTextFromPayload(payload);
      const estado = computeEstadoForHistoryEntry(opId, entry, idx, history);
      const statusPill = renderHistorialEstadoPillHtml(estado);
      const pdfBtn =
        opNombre
          ? `<button type="button" class="admin-history-item-pdf-btn portal-history-pastel-pdf-btn" data-history-op-id="${escapeHtml(String(opId))}" data-history-ts="${entry && entry.ts ? escapeHtml(String(entry.ts)) : ""}">Generar PDF</button>`
          : "";
      const ariaLabel = `Solicitud ${idx + 1}. ${tsText || "—"}. ${motive}.`;
      return `<article class="portal-history-pastel-card" role="listitem" aria-label="${escapeHtml(ariaLabel)}">
        <header class="portal-history-pastel-head">
          <time class="portal-history-pastel-time" datetime="${escapeHtml(tsIso)}">${escapeHtml(tsText)}</time>
          <span class="portal-history-pastel-tipo">${escapeHtml(tipo)}</span>
        </header>
        <h3 class="portal-history-pastel-motive">${escapeHtml(motive)}</h3>
        <p class="portal-history-pastel-summary">${escapeHtml(summary)}</p>
        <footer class="portal-history-pastel-foot">
          <div class="portal-history-pastel-status">${statusPill}</div>
          <div class="portal-history-pastel-pdf">${pdfBtn}</div>
        </footer>
      </article>`;
    })
    .join("");

  return `<div class="portal-history-pastel" role="list">${items}</div>`;
}

/**
 * portal.html — Diseño 26: tarjetas solapadas (abanico, z-index por antigüedad).
 */
function buildPortalRequestHistoryFanHtml(opId) {
  const history = resolvePortalOperatorHistoryEntriesSorted(opId);
  if (!history.length) return "";

  const opNombre = resolveHistoryFooterOperatorNombre(opId);
  const total = history.length;
  const items = history
    .map((entry, idx) => {
      const ts = entry && entry.ts ? new Date(entry.ts) : null;
      const tsText = ts ? ts.toLocaleString() : "";
      const tsIso = ts ? ts.toISOString() : "";
      const tipoRaw = entry && entry.tipo ? String(entry.tipo) : "";
      const tipo =
        tipoRaw === "Solicitud guardada" || tipoRaw === "Modificación"
          ? "Solicitud"
          : tipoRaw || "Solicitud";
      const payload = entry && entry.payload ? entry.payload : {};
      const motive =
        payload && payload.motive ? String(payload.motive) : "—";
      const summary = buildPortalHistorySummaryTextFromPayload(payload);
      const estado = computeEstadoForHistoryEntry(opId, entry, idx, history);
      const statusPill = renderHistorialEstadoPillHtml(estado);
      const pdfBtn =
        opNombre
          ? `<button type="button" class="admin-history-item-pdf-btn portal-history-fan-pdf-btn" data-history-op-id="${escapeHtml(String(opId))}" data-history-ts="${entry && entry.ts ? escapeHtml(String(entry.ts)) : ""}">Generar PDF</button>`
          : "";
      const z = total - idx;
      const ariaLabel = `Ficha ${idx + 1}. ${tsText || "—"}. ${motive}.`;
      return `<article class="portal-history-fan-card" role="listitem" aria-label="${escapeHtml(ariaLabel)}" style="z-index:${z}">
        <header class="portal-history-fan-head">
          <time class="portal-history-fan-time" datetime="${escapeHtml(tsIso)}">${escapeHtml(tsText)}</time>
          <span class="portal-history-fan-tipo">${escapeHtml(tipo)}</span>
        </header>
        <h3 class="portal-history-fan-motive">${escapeHtml(motive)}</h3>
        <p class="portal-history-fan-summary">${escapeHtml(summary)}</p>
        <footer class="portal-history-fan-foot">
          <div class="portal-history-fan-status">${statusPill}</div>
          <div class="portal-history-fan-pdf">${pdfBtn}</div>
        </footer>
      </article>`;
    })
    .join("");

  return `<div class="portal-history-fan-stack" role="list">${items}</div>`;
}

/**
 * portal.html — Diseño 27: entradas tipo ticket (talón + perforación + cuerpo).
 */
function buildPortalRequestHistoryTicketHtml(opId) {
  const history = resolvePortalOperatorHistoryEntriesSorted(opId);
  if (!history.length) return "";

  const opNombre = resolveHistoryFooterOperatorNombre(opId);
  const items = history
    .map((entry, idx) => {
      const ts = entry && entry.ts ? new Date(entry.ts) : null;
      const tsText = ts ? ts.toLocaleString() : "";
      const tsIso = ts ? ts.toISOString() : "";
      const tipoRaw = entry && entry.tipo ? String(entry.tipo) : "";
      const tipo =
        tipoRaw === "Solicitud guardada" || tipoRaw === "Modificación"
          ? "Solicitud"
          : tipoRaw || "Solicitud";
      const payload = entry && entry.payload ? entry.payload : {};
      const motive =
        payload && payload.motive ? String(payload.motive) : "—";
      const summary = buildPortalHistorySummaryTextFromPayload(payload);
      const estado = computeEstadoForHistoryEntry(opId, entry, idx, history);
      const statusPill = renderHistorialEstadoPillHtml(estado);
      const pdfBtn =
        opNombre
          ? `<button type="button" class="admin-history-item-pdf-btn portal-history-ticket-pdf-btn" data-history-op-id="${escapeHtml(String(opId))}" data-history-ts="${entry && entry.ts ? escapeHtml(String(entry.ts)) : ""}">Generar PDF</button>`
          : "";
      const ariaLabel = `Entrada ${idx + 1}. ${tsText || "—"}. ${motive}.`;
      return `<article class="portal-history-ticket" role="listitem" aria-label="${escapeHtml(ariaLabel)}">
        <div class="portal-history-ticket-stub" aria-hidden="true">
          <span class="portal-history-ticket-stub-label">Nº</span>
          <span class="portal-history-ticket-stub-num">${idx + 1}</span>
          <time class="portal-history-ticket-stub-time" datetime="${escapeHtml(tsIso)}">${escapeHtml(tsText)}</time>
          <span class="portal-history-ticket-stub-tipo">${escapeHtml(tipo)}</span>
        </div>
        <div class="portal-history-ticket-perf" aria-hidden="true"></div>
        <div class="portal-history-ticket-body">
          <h3 class="portal-history-ticket-motive">${escapeHtml(motive)}</h3>
          <p class="portal-history-ticket-summary">${escapeHtml(summary)}</p>
          <footer class="portal-history-ticket-foot">
            <div class="portal-history-ticket-status">${statusPill}</div>
            <div class="portal-history-ticket-pdf">${pdfBtn}</div>
          </footer>
        </div>
      </article>`;
    })
    .join("");

  return `<div class="portal-history-ticket-list" role="list">${items}</div>`;
}

/**
 * portal.html — Diseño 3: historial como tabla (mismos datos que buildAdminRequestHistoryItemsHtml).
 */
function buildPortalRequestHistoryTableHtml(opId) {
  const history = resolvePortalOperatorHistoryEntriesSorted(opId);
  if (!history.length) return "";

  const opNombre = resolveHistoryFooterOperatorNombre(opId);
  const rows = history
    .map((entry, idx) => {
      const ts = entry && entry.ts ? new Date(entry.ts) : null;
      const tsText = ts ? ts.toLocaleString() : "";
      const tipoRaw = entry && entry.tipo ? String(entry.tipo) : "";
      const tipo =
        tipoRaw === "Solicitud guardada" || tipoRaw === "Modificación"
          ? "Solicitud"
          : tipoRaw || "Solicitud";
      const payload = entry && entry.payload ? entry.payload : {};
      const motive =
        payload && payload.motive ? String(payload.motive) : "—";
      const summary = buildPortalHistorySummaryTextFromPayload(payload);
      const estado = computeEstadoForHistoryEntry(opId, entry, idx, history);
      const statusPill = renderHistorialEstadoPillHtml(estado);
      const pdfBtn =
        opNombre
          ? `<button type="button" class="admin-history-item-pdf-btn portal-history-table-pdf-btn" data-history-op-id="${escapeHtml(String(opId))}" data-history-ts="${entry && entry.ts ? escapeHtml(String(entry.ts)) : ""}">Generar PDF</button>`
          : "";
      return `<tr>
        <td class="portal-history-td-date">${escapeHtml(tsText)}</td>
        <td class="portal-history-td-tipo">${escapeHtml(tipo)}</td>
        <td class="portal-history-td-motive">${escapeHtml(motive)}</td>
        <td class="portal-history-td-summary">${escapeHtml(summary)}</td>
        <td class="portal-history-td-estado">${statusPill}</td>
        <td class="portal-history-td-pdf">${pdfBtn}</td>
      </tr>`;
    })
    .join("");

  return `<div class="portal-history-table-scroll" role="region" aria-label="Historial de solicitudes en tabla">
    <table class="portal-history-table">
      <thead>
        <tr>
          <th scope="col">Fecha</th>
          <th scope="col">Tipo</th>
          <th scope="col">Motivo</th>
          <th scope="col">Resumen</th>
          <th scope="col">Estado</th>
          <th scope="col">PDF</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

/**
 * @param {Array} entries — filas de historial (local y/o Firestore).
 * @param {{ defaultOpId?: string, omitPdfButton?: boolean, forceOperatorFooter?: boolean }} [options]
 */
function buildAdminRequestHistoryItemsFromEntries(entries, options) {
  options = options || {};
  const omitPdfButton = !!options.omitPdfButton;
  const forceOperatorFooter = !!options.forceOperatorFooter;
  const defaultOpId =
    options.defaultOpId != null ? String(options.defaultOpId) : "";
  const historialMultiOp = !!forceOperatorFooter;

  if (!entries || !entries.length) return "";

  return entries
    .map(function (entry, idx) {
      const rowOpId =
        entry &&
        entry.operatorId != null &&
        String(entry.operatorId).trim() !== ""
          ? String(entry.operatorId).trim()
          : defaultOpId;
      const ts = entry && entry.ts ? new Date(entry.ts) : null;
      const tsText = ts ? ts.toLocaleString() : "";
      const tsIso = ts && !Number.isNaN(ts.getTime()) ? ts.toISOString() : "";
      const tipoRaw = entry && entry.tipo ? String(entry.tipo) : "";
      const tipo =
        tipoRaw === "Solicitud guardada" || tipoRaw === "Modificación"
          ? "Solicitud"
          : tipoRaw || "Solicitud";
      const payload = entry && entry.payload ? entry.payload : {};
      const details = renderAdminRequestDetailsHtmlFromPayload(payload);
      const estado = computeEstadoForHistoryEntry(
        rowOpId,
        entry,
        idx,
        entries,
        historialMultiOp ? { historialMultiOp: true } : null
      );
      const statusPill = renderHistorialEstadoPillHtml(estado);
      let opNombre = "";
      if (
        entry &&
        entry.operatorName != null &&
        String(entry.operatorName).trim() !== ""
      ) {
        opNombre = String(entry.operatorName).trim();
      } else if (rowOpId) {
        opNombre = resolveHistoryFooterOperatorNombre(rowOpId) || "";
      }
      if (forceOperatorFooter && !opNombre && rowOpId) {
        opNombre = "Operador " + rowOpId;
      }
      const showFooter = forceOperatorFooter ? !!rowOpId : !!opNombre;
      return `
        <article class="admin-history-item" aria-label="${escapeHtml(tipo)}">
          <div class="admin-history-item-inner">
            <div class="admin-history-item-head">
              <span class="admin-history-item-head-main">
                <span class="admin-history-item-badge">${escapeHtml(tipo)}</span>
                ${statusPill}
              </span>
              ${tsText ? `<time class="admin-history-item-date"${tsIso ? ` datetime="${escapeHtml(tsIso)}"` : ""}>${escapeHtml(tsText)}</time>` : ""}
            </div>
            <div class="admin-history-item-body">
              ${details}
            </div>
            ${
              showFooter
                ? `<div class="admin-history-item-footer"><span><strong>Operador:</strong> ${escapeHtml(opNombre || "—")}</span>${
                    omitPdfButton
                      ? ""
                      : `<button type="button" class="admin-history-item-pdf-btn" data-history-op-id="${escapeHtml(String(rowOpId))}" data-history-ts="${entry && entry.ts ? escapeHtml(String(entry.ts)) : ""}">Generar PDF</button>`
                  }</div>`
                : ""
            }
          </div>
        </article>
      `;
    })
    .join("");
}

/**
 * Misma marca HTML que el historial de solicitudes en admin.html (ítems + lista).
 * @param {{ onlyLatest?: boolean, omitPdfButton?: boolean }} [options] — onlyLatest: portal solo última fila; omitPdfButton: sin «Generar PDF» en pie (recuadro central #portalInlineLatestSolicitudWrap; el historial desplegable sigue con PDF).
 */
function buildAdminRequestHistoryItemsHtml(opId, options) {
  options = options || {};
  const onlyLatest = !!options.onlyLatest;
  const omitPdfButton = !!options.omitPdfButton;
  if (!opId) return "";

  let history = resolveMergedOperatorHistoryEntries(opId);
  history.sort(
    (a, b) => (b && b.ts ? b.ts : 0) - (a && a.ts ? a.ts : 0)
  );

  if (!history.length) return "";

  if (onlyLatest) {
    history = [history[0]];
  }

  return buildAdminRequestHistoryItemsFromEntries(history, {
    defaultOpId: String(opId),
    omitPdfButton: omitPdfButton,
    forceOperatorFooter: false,
  });
}

function renderAdminRequestHistory(opId) {
  const list = document.getElementById("adminHistoryList");
  if (!list) return;
  if (!opId) {
    list.innerHTML = "";
    return;
  }

  const itemsHtml = buildAdminRequestHistoryItemsHtml(opId);
  if (!itemsHtml) {
    list.innerHTML = "<p style='margin:0;color:#000000;'>No hay solicitudes guardadas en el historial.</p>";
    return;
  }

  list.innerHTML = itemsHtml;
}

function maybeRenderAdminRequestHistory() {
  const content = document.getElementById("adminHistoryContent");
  if (!content) return;
  const isVisible = content.style.display !== "none";
  if (!isVisible) return;
  if (getAdminHistorialFirestoreMode() === "all") {
    refreshAdminHistorialFromFirestoreAndRender();
    return;
  }
  const opId =
    state.filtered && state.filtered.length === 1 && state.filtered[0].id
      ? String(state.filtered[0].id)
      : "";
  if (!opId) {
    const list = document.getElementById("adminHistoryList");
    if (list) list.innerHTML = "";
    return;
  }
  refreshAdminHistorialFromFirestoreAndRender();
}

function setupAdminRequestHistoryToggle() {
  const btn = document.getElementById("adminHistoryToggleBtn");
  const content = document.getElementById("adminHistoryContent");
  if (!btn || !content) return;
  if (btn.dataset.bound === "1") return;
  btn.dataset.bound = "1";

  btn.addEventListener("click", function () {
    const isHidden = content.style.display === "none";
    content.style.display = isHidden ? "block" : "none";
    btn.setAttribute("aria-expanded", String(isHidden));
    // Cuando se abre, renderizamos el historial para el operador actual.
    if (isHidden) {
      maybeRenderAdminRequestHistory();
    }
  });
}

/**
 * Identificador estable del administrador en esta sesión (usuario de login). El acuse de
 * lectura en localStorage es por admin: un clic solo baja el contador para quien hizo clic.
 */
function getAdminNotificationViewerKey() {
  const u = (window.sessionStorage.getItem("vacaciones_admin_username") || "").trim();
  if (u) {
    return u.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
  }
  const p = window.sessionStorage.getItem("vacaciones_admin_profile");
  if (p) {
    return "profile_" + String(p).replace(/[^a-zA-Z0-9_-]/g, "_");
  }
  if (window.sessionStorage.getItem("vacaciones_role") === "maestro") {
    return "maestro";
  }
  return "viewer_default";
}

/**
 * Una sola notificación por operador. La "versión" combina el último ts del historial
 * (nuevo guardado/modificación en portal) + huella del payload: al modificar en curso se
 * actualiza la misma fila y el contador no suma dos; cambios solo de estadoHistorial en
 * historial (sin nuevo ts ni payload distinto) no disparan otra notificación.
 */
function adminNotificationAckStorageKey(opId) {
  return `vacaciones_admin_notif_ack_${getAdminNotificationViewerKey()}_${String(opId)}`;
}

function getAdminNotificationPayloadRaw(opId) {
  const key = `vacaciones_last_saved_payload_${String(opId)}`;
  return window.localStorage.getItem(key) || "";
}

function adminNotificationPayloadHash(raw) {
  if (!raw) return "0";
  let h = 5381 >>> 0;
  for (let i = 0; i < raw.length; i++) {
    h = (((h << 5) + h) ^ raw.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

function getAdminNotificationLatestHistoryTs(opId) {
  const history = getAdminRequestHistory(opId);
  let maxTs = 0;
  for (let i = 0; i < history.length; i++) {
    const t = history[i] && history[i].ts ? Number(history[i].ts) : 0;
    if (t > maxTs) maxTs = t;
  }
  return maxTs;
}

/** Token estable por revisión: mismo operador = una notificación que se actualiza al cambiar guardado o historial de envíos. */
function getAdminNotificationSolicitudVersionToken(opId) {
  const raw = getAdminNotificationPayloadRaw(opId);
  const maxTs = getAdminNotificationLatestHistoryTs(opId);
  return (
    String(maxTs) +
    "|" +
    adminNotificationPayloadHash(raw) +
    "|" +
    String(raw.length)
  );
}

function isAdminNotificationUnread(opId) {
  if (!operatorHasValidSavedRequestInStorage(opId)) return false;
  if (permisoAllThreeAdminsDecided(opId)) return false;
  const raw = getAdminNotificationPayloadRaw(opId);
  if (!raw) return true;
  const ack = window.localStorage.getItem(adminNotificationAckStorageKey(opId));
  return ack !== getAdminNotificationSolicitudVersionToken(opId);
}

function markAdminNotificationAcknowledged(opId) {
  if (!opId) return;
  const id = String(opId);
  if (!operatorHasValidSavedRequestInStorage(id)) return;
  window.localStorage.setItem(
    adminNotificationAckStorageKey(id),
    getAdminNotificationSolicitudVersionToken(id)
  );
}

function getAdminNotificationUnreadCount() {
  if (!isAdminHtmlPage() || !state.operators || !state.operators.length) return 0;
  let n = 0;
  for (let i = 0; i < state.operators.length; i++) {
    const op = state.operators[i];
    const opId = op && op.id != null ? String(op.id) : "";
    if (!opId) continue;
    if (isAdminNotificationUnread(opId)) n++;
  }
  return n;
}

/** Operadores con solicitud guardada desde portal (admin.html): lista del centro de notificaciones. */
function getAdminNotificationEntries() {
  if (!isAdminHtmlPage() || !state.operators || !state.operators.length) return [];
  const out = [];
  for (let i = 0; i < state.operators.length; i++) {
    const op = state.operators[i];
    const opId = op && op.id != null ? String(op.id) : "";
    if (!opId || !operatorHasValidSavedRequestInStorage(opId)) continue;
    if (permisoAllThreeAdminsDecided(opId)) continue;
    const unread = isAdminNotificationUnread(opId);
    const s = withComputedEstatusFinal(getPermisoStatus(opId));
    const finalV = normalizePermisoRowValue(s.estatusFinal);
    let statusKey = "pendiente";
    let statusLabel = "Pendiente";
    if (finalV === "aprobado") {
      statusKey = "aprobado";
      statusLabel = "Aprobado";
    } else if (finalV === "rechazado") {
      statusKey = "rechazado";
      statusLabel = "Rechazado";
    }
    const payload = getLastSavedPayloadFromOperator(opId);
    const motive =
      payload && payload.motive ? String(payload.motive) : "Solicitud";
    const ts = getAdminNotificationLatestHistoryTs(opId);
    const tsText = ts ? new Date(ts).toLocaleString() : "";
    const sortPrio =
      finalV === "pendiente" ? 0 : finalV === "aprobado" ? 1 : 2;
    out.push({
      opId,
      nombre: op.nombreCompleto || "",
      motive,
      statusKey,
      statusLabel,
      tsText,
      ts,
      sortPrio,
      unread,
    });
  }
  /* Orden fijo: no reordenar por leída/no leída (no mover la fila al hacer clic). */
  out.sort(function (a, b) {
    if (a.sortPrio !== b.sortPrio) return a.sortPrio - b.sortPrio;
    if (b.ts !== a.ts) return b.ts - a.ts;
    return String(a.opId).localeCompare(String(b.opId));
  });
  return out;
}

function refreshAdminNotificationList() {
  const list = document.getElementById("adminNotificationList");
  const countEl = document.getElementById("adminNotificationCount");
  if (!list || !isAdminHtmlPage()) return;
  const entries = getAdminNotificationEntries();
  const unreadCount = getAdminNotificationUnreadCount();
  if (countEl) {
    countEl.textContent = unreadCount > 9 ? "+9" : String(unreadCount);
    countEl.style.visibility = unreadCount ? "visible" : "hidden";
  }
  if (!entries.length) {
    list.innerHTML =
      '<p class="admin-notification-empty">Sin solicitudes pendientes.</p>';
    return;
  }
  list.innerHTML = entries
    .map(function (e) {
      const safeId = escapeHtml(e.opId);
      const safeNombre = escapeHtml(e.nombre);
      const safeMotive = escapeHtml(e.motive);
      const safeStatus = escapeHtml(e.statusLabel);
      const safeTime = escapeHtml(e.tsText || "Sin fecha registrada");
      const itemClass =
        "admin-notification-item " +
        (e.unread
          ? "admin-notification-item--unread"
          : "admin-notification-item--read");
      const statusClass =
        e.statusKey === "aprobado"
          ? "admin-notification-item-status--aprobado"
          : e.statusKey === "rechazado"
            ? "admin-notification-item-status--rechazado"
            : "admin-notification-item-status--pendiente";
      return (
        '<button type="button" class="' +
        itemClass +
        '" data-notification-op-id="' +
        safeId +
        '" aria-label="Abrir perfil del operador ' +
        safeNombre +
        ", ID " +
        safeId +
        '">' +
        '<div class="admin-notification-item-head">' +
        '<span class="admin-notification-item-operator">' +
        safeNombre +
        "</span>" +
        '<span class="admin-notification-item-status ' +
        statusClass +
        '">' +
        safeStatus +
        "</span>" +
        "</div>" +
        '<div class="admin-notification-item-detail">ID ' +
        safeId +
        " · " +
        safeMotive +
        "</div>" +
        (e.tsText
          ? '<div class="admin-notification-item-time">' + safeTime + "</div>"
          : "") +
        "</button>"
      );
    })
    .join("");
}

function setAdminNotificationPanelOpen(open) {
  const panel = document.getElementById("adminNotificationPanel");
  const btn = document.getElementById("adminNotificationBtn");
  if (!panel || !btn) return;
  panel.style.display = open ? "block" : "none";
  btn.setAttribute("aria-expanded", open ? "true" : "false");
}

function selectAdminOperatorFromNotification(opId) {
  const id = String(opId || "").trim();
  if (!id) return;
  const searchInput = document.getElementById("searchInput");
  if (searchInput) {
    searchInput.value = id;
    searchInput.readOnly = false;
  }
  applyFilters();
  markAdminNotificationAcknowledged(id);
  refreshAdminNotificationList();
  setAdminNotificationPanelOpen(false);
  if (searchInput) {
    try {
      searchInput.focus();
    } catch (err) {
      /* ignore */
    }
  }
}

function setupAdminNotificationCenter() {
  if (!isAdminHtmlPage() || window.__adminNotificationCenterBound) return;
  window.__adminNotificationCenterBound = true;

  const btn = document.getElementById("adminNotificationBtn");
  const panel = document.getElementById("adminNotificationPanel");
  const center = document.getElementById("adminNotificationCenter");
  const list = document.getElementById("adminNotificationList");
  if (!btn || !panel || !center) return;

  btn.addEventListener("click", function (ev) {
    ev.stopPropagation();
    const open = panel.style.display === "none" || panel.style.display === "";
    if (open) refreshAdminNotificationList();
    setAdminNotificationPanelOpen(open);
  });

  if (list) {
    list.addEventListener("click", function (ev) {
      const item = ev.target.closest("[data-notification-op-id]");
      if (!item || !list.contains(item)) return;
      const oid = item.getAttribute("data-notification-op-id");
      if (oid) selectAdminOperatorFromNotification(oid);
    });
  }

  document.addEventListener("click", function (ev) {
    if (!center.contains(ev.target)) {
      setAdminNotificationPanelOpen(false);
    }
  });

  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "Escape") return;
    if (panel.style.display !== "none") {
      setAdminNotificationPanelOpen(false);
    }
  });

  if (!window.__adminNotificationStorageBound) {
    window.__adminNotificationStorageBound = true;
    window.addEventListener("storage", function (ev) {
      if (!isAdminHtmlPage()) return;
      const role = window.sessionStorage.getItem("vacaciones_role");
      if (role !== "admin" && role !== "maestro") return;
      const k = ev.key || "";
      if (
        k &&
        !k.startsWith("vacaciones_last_saved_locked_mode_") &&
        !k.startsWith("vacaciones_last_saved_payload_") &&
        !k.startsWith("vacaciones_permiso_status_") &&
        !k.startsWith("vacaciones_admin_request_history_") &&
        !k.startsWith("vacaciones_admin_notif_ack_")
      ) {
        return;
      }
      refreshAdminNotificationList();
    });
  }
}

function renderAdminSavedRequestSummary() {
  try {
  syncAdminSavedRequestActionsLayout(null);
  const content = document.getElementById("adminSavedRequestContent");
  if (!content) return;

  const role =
    state.currentRole || window.sessionStorage.getItem("vacaciones_role");
  const isAdminLike = role === "admin" || role === "maestro";
  if (!isAdminLike) {
    content.innerHTML = "";
    syncAdminHtmlSavedRequestActionButtons();
    updateEstatusPermisoActionButtonsState();
    return;
  }

  if (!state.filtered || state.filtered.length !== 1) {
    content.innerHTML = "";
    syncAdminHtmlSavedRequestActionButtons();
    updateEstatusPermisoActionButtonsState();
    return;
  }

  const op = state.filtered[0];
  const opId = op && op.id ? String(op.id) : "";
  if (!opId) {
    content.innerHTML = "";
    syncAdminHtmlSavedRequestActionButtons();
    updateEstatusPermisoActionButtonsState();
    return;
  }

  migrateGlobalSavedPayloadToOperatorIfNeeded(opId);

  const modeKey = `vacaciones_last_saved_locked_mode_${opId}`;
  const payloadKey = `vacaciones_last_saved_payload_${opId}`;
  const mode = window.localStorage.getItem(modeKey);
  const payloadRaw = window.localStorage.getItem(payloadKey);

  if (mode !== "1" || !payloadRaw) {
    content.innerHTML = "<p style='margin:0;'>Sin solicitud guardada para este operador.</p>";
    syncAdminHtmlSavedRequestActionButtons();
    updateEstatusPermisoActionButtonsState();
    return;
  }

  let payload = null;
  try {
    payload = JSON.parse(payloadRaw);
  } catch (e) {
    payload = null;
  }

  if (!payload || typeof payload !== "object") {
    content.innerHTML = "<p style='margin:0;'>Hay datos guardados, pero están dañados.</p>";
    syncAdminHtmlSavedRequestActionButtons();
    updateEstatusPermisoActionButtonsState();
    return;
  }

  const motive =
    payload.motive != null && String(payload.motive).trim() !== ""
      ? String(payload.motive).trim()
      : "Sin motivo";
  const values =
    payload.values && typeof payload.values === "object" ? payload.values : {};
  const getValue = (id) => {
    const v = values[id];
    return typeof v === "string" ? v.trim() : "";
  };
  const formatDate = (dayId, monthId, yearId) => {
    const d = getValue(dayId);
    const m = getValue(monthId);
    const y = getValue(yearId);
    if (!d || !m || !y) return "No disponible";
    return `${d}/${m}/${y}`;
  };

  let detailsHtml = "";
  if (motive === "Vacaciones") {
    const dias = getValue("diasSolicitadosInput") || "No disponible";
    const inicio = formatDate("fechaDiaSelect", "fechaMesSelect", "fechaAnioSelect");
    const fin = formatDate("fechaDiaSelectFin", "fechaMesSelectFin", "fechaAnioSelectFin");
    detailsHtml = `
      <div><strong>No. días:</strong> ${escapeHtml(dias)}</div>
      <div><strong>Fechas a disfrutar:</strong> ${escapeHtml(inicio)} a ${escapeHtml(fin)}</div>
    `;
  } else if (motive === "Falta justificada") {
    const diasFj =
      getValue("diasSolicitadosFaltaJustificadaInput") || "No disponible";
    const inicio = formatDate(
      "fechaJustificarDiaSelect",
      "fechaJustificarMesSelect",
      "fechaJustificarAnioSelect"
    );
    const fin = formatDate(
      "fechaJustificarDiaSelectFin",
      "fechaJustificarMesSelectFin",
      "fechaJustificarAnioSelectFin"
    );
    const motivoTexto = getValue("motivoFaltaJustificadaInput") || "No disponible";
    detailsHtml = `
      <div><strong>No. días:</strong> ${escapeHtml(diasFj)}</div>
      <div><strong>Fechas a justificar:</strong> ${escapeHtml(inicio)} a ${escapeHtml(fin)}</div>
      <div><strong>Motivo:</strong> ${escapeHtml(motivoTexto)}</div>
    `;
  } else if (motive === "Permiso sin goce") {
    const diasSg =
      getValue("diasSolicitadosPermisoSinGoceInput") || "No disponible";
    const inicio = formatDate(
      "fechaPermisoSinGoceDiaSelect",
      "fechaPermisoSinGoceMesSelect",
      "fechaPermisoSinGoceAnioSelect"
    );
    const fin = formatDate(
      "fechaPermisoSinGoceDiaSelectFin",
      "fechaPermisoSinGoceMesSelectFin",
      "fechaPermisoSinGoceAnioSelectFin"
    );
    const motivoTexto = getValue("motivoPermisoSinGoceInput") || "No disponible";
    detailsHtml = `
      <div><strong>No. días:</strong> ${escapeHtml(diasSg)}</div>
      <div><strong>Fechas del permiso:</strong> ${escapeHtml(inicio)} a ${escapeHtml(fin)}</div>
      <div><strong>Motivo:</strong> ${escapeHtml(motivoTexto)}</div>
    `;
  } else if (motive === "Permiso con goce") {
    const tipoPermiso = getValue("permisoGoceSelect") || "No disponible";
    const diasPg =
      getValue("diasSolicitadosPermisoGoceInput") || "No disponible";
    const inicio = formatDate(
      "fechaPermisoDiaSelect",
      "fechaPermisoMesSelect",
      "fechaPermisoAnioSelect"
    );
    const fin = formatDate(
      "fechaPermisoDiaSelectFin",
      "fechaPermisoMesSelectFin",
      "fechaPermisoAnioSelectFin"
    );
    detailsHtml = `
      <div><strong>Tipo de permiso:</strong> ${escapeHtml(tipoPermiso)}</div>
      <div><strong>No. días:</strong> ${escapeHtml(diasPg)}</div>
      <div><strong>Fechas del permiso:</strong> ${escapeHtml(inicio)} a ${escapeHtml(fin)}</div>
    `;
  } else {
    detailsHtml = "<div><strong>Detalle:</strong> Sin formato para este motivo.</div>";
  }

  content.innerHTML = `
    <div style="display:grid; gap:6px;">
      <div><strong>Operador:</strong> ${escapeHtml(op.nombreCompleto || "")}</div>
      <div><strong>Motivo de ausencia:</strong> ${escapeHtml(motive)}</div>
      ${detailsHtml}
    </div>
  `;
  syncAdminHtmlSavedRequestActionButtons();
  updateEstatusPermisoActionButtonsState();
  } finally {
    if (isAdminHtmlPage()) refreshAdminNotificationList();
  }
}

function refreshAdminSavedRequestOnStorageChange(event) {
  const content = document.getElementById("adminSavedRequestContent");
  if (!content) return;

  const role =
    state.currentRole || window.sessionStorage.getItem("vacaciones_role");
  const isAdminLike = role === "admin" || role === "maestro";
  if (!isAdminLike) return;

  const changedKey = event && typeof event.key === "string" ? event.key : "";
  if (
    changedKey &&
    changedKey.startsWith("vacaciones_portal_modificar_cambios_active_")
  ) {
    updateEstatusPermisoActionButtonsState();
    return;
  }

  if (
    changedKey &&
    changedKey.startsWith("vacaciones_admin_request_history_") &&
    state.filtered &&
    state.filtered.length === 1
  ) {
    const opIdFromKey = changedKey.replace("vacaciones_admin_request_history_", "");
    if (String(state.filtered[0].id) === String(opIdFromKey)) {
      maybeRenderAdminRequestHistory();
    }
    return;
  }
  if (
    changedKey &&
    changedKey.startsWith("vacaciones_permiso_status_") &&
    state.filtered &&
    state.filtered.length === 1
  ) {
    const opIdFromKey = changedKey.replace("vacaciones_permiso_status_", "");
    if (String(state.filtered[0].id) === String(opIdFromKey)) {
      refreshPortalPermisoStatusUI(String(opIdFromKey));
      updateEstatusPermisoActionButtonsState();
    }
    return;
  }

  if (
    changedKey &&
    !changedKey.startsWith("vacaciones_last_saved_locked_mode_") &&
    !changedKey.startsWith("vacaciones_last_saved_payload_") &&
    !changedKey.startsWith("vacaciones_admin_request_history_")
  ) {
    return;
  }

  if (!state.filtered || state.filtered.length !== 1) return;
  const op = state.filtered[0];
  const opId = op && op.id ? String(op.id) : "";
  if (!opId) return;

  const modeKey = `vacaciones_last_saved_locked_mode_${opId}`;
  const payloadKey = `vacaciones_last_saved_payload_${opId}`;
  if (changedKey && changedKey !== modeKey && changedKey !== payloadKey) return;

  if (changedKey === modeKey || changedKey === payloadKey) {
    clearAdminModifEstadoSession(opId);
  }
  renderAdminSavedRequestSummary();
}

function renderOperatorsTable() {
  const container = document.getElementById("operatorDetailContent");
  if (!container) return;

  if (!state.filtered.length) {
    const roleAfter =
      state.currentRole || window.sessionStorage.getItem("vacaciones_role");
    const isAdminLike = roleAfter === "admin" || roleAfter === "maestro";
    if (isAdminLike) {
      container.innerHTML = "";
      return;
    }

    const searchInput = document.getElementById("searchInput");
    const shiftFilter = document.getElementById("shiftFilter");
    const search =
      (searchInput && searchInput.value.toLowerCase().trim()) || "";
    const shift = (shiftFilter && shiftFilter.value) || "";

    if (!search && !shift) {
      container.innerHTML = `
        <p class="subtitle">
          Selecciona un operador escribiendo su ID o nombre (el turno solo no selecciona uno).
        </p>
      `;
    } else {
      container.innerHTML = `<p class="subtitle">${
        state.selectionMessage ||
        "No se encontró ningún operador con esos filtros."
      }</p>`;
    }
    return;
  }

  const op = state.filtered[0];

  container.innerHTML = `
    <table class="operator-detail-table" aria-label="Datos del operador">
      <tbody>
        <tr><td class="operator-detail-label">ID</td><td>${escapeHtml(op.id)}</td></tr>
        <tr><td class="operator-detail-label">Nombre</td><td>${escapeHtml(op.nombreCompleto)}</td></tr>
        <tr><td class="operator-detail-label">Puesto</td><td>${escapeHtml(op.puesto)}</td></tr>
        <tr><td class="operator-detail-label">Turno</td><td>${escapeHtml(op.turno)}</td></tr>
        <tr><td class="operator-detail-label">Fech. Ingr.</td><td>${escapeHtml(op.fechaIngreso)}</td></tr>
      </tbody>
    </table>
  `;
}

function renderAbsencesTable() {
  const tbody = document.getElementById("absencesTableBody");
  if (!tbody) return;
  tbody.innerHTML = "";

  const role =
    state.currentRole || window.sessionStorage.getItem("vacaciones_role");

  for (const op of state.filtered) {
    let badgeClass = "badge-motivo";
    if (op.motivo === "Vacaciones") badgeClass = "badge-success";
    if (op.motivo === "Permiso sin goce") badgeClass = "badge-warning";

    const diasDisponiblesMostrar =
      role === "local"
        ? getPortalVacationSaldoRestante(op.id)
        : op.diasDisponibles;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <span class="badge ${badgeClass}">${op.motivo}</span>
      </td>
      <td>${op.diasVacacionales}</td>
      <td>${op.diasInhabiles}</td>
      <td>${diasDisponiblesMostrar}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderApprovalsTable() {
  const tbody = document.getElementById("approvalsTableBody");
  if (!tbody) return;
  tbody.innerHTML = "";

  const role =
    state.currentRole || window.sessionStorage.getItem("vacaciones_role");
  const isAdminLike = role === "admin" || role === "maestro";

  for (const op of state.filtered) {
    const getStatusBadge = (approved) =>
      approved
        ? '<span class="badge badge-success">Aprobado</span>'
        : '<span class="badge badge-warning">Pendiente</span>';

    const finalClass =
      op.estadoFinal === "Aprobado" ? "badge-success" : "badge-danger";

    const tr = document.createElement("tr");
    if (isAdminLike) {
      tr.innerHTML = `
        <td>${getStatusBadge(op.supervisorAprueba)}</td>
        <td>${getStatusBadge(op.gerenteAprueba)}</td>
        <td>${getStatusBadge(op.rhAprueba)}</td>
        <td>
          <span class="badge ${finalClass}">${op.estadoFinal}</span>
          <div style="margin-top:4px; display:flex; gap:4px;">
            <button
              class="admin-approval-btn"
              data-action="approve"
              data-id="${op.id}"
            >
              Aprobar
            </button>
            <button
              class="admin-approval-btn"
              data-action="reject"
              data-id="${op.id}"
            >
              Rechazar
            </button>
          </div>
        </td>
      `;
    } else {
      // Usuario local: solo visualiza el estado
      tr.innerHTML = `
        <td>${getStatusBadge(op.supervisorAprueba)}</td>
        <td>${getStatusBadge(op.gerenteAprueba)}</td>
        <td>${getStatusBadge(op.rhAprueba)}</td>
        <td>
          <span class="badge ${finalClass}">${op.estadoFinal}</span>
        </td>
      `;
    }
    tbody.appendChild(tr);
  }

  if (isAdminLike && !isAdminHtmlPage()) {
    tbody.onclick = (event) => {
      const btn = event.target.closest(".admin-approval-btn");
      if (!btn) return;
      const id = btn.getAttribute("data-id");
      const action = btn.getAttribute("data-action");
      const op = state.operators.find((o) => o.id === id);
      if (!op) return;

      if (action === "approve") {
        op.supervisorAprueba = true;
        op.gerenteAprueba = true;
        op.rhAprueba = true;
        op.estadoFinal = "Aprobado";
      } else if (action === "reject") {
        op.supervisorAprueba = false;
        op.gerenteAprueba = false;
        op.rhAprueba = false;
        op.estadoFinal = "Pendiente / Rechazado";
      }

      renderApprovalsTable();
    };
  }
}

function applyFilters() {
  const searchInput = document.getElementById("searchInput");
  const shiftFilter = document.getElementById("shiftFilter");
  const roleForSearch =
    state.currentRole || window.sessionStorage.getItem("vacaciones_role");
  const operatorIdForSearch =
    state.currentOperatorId || window.sessionStorage.getItem("vacaciones_operator_id");
  let rawSearch = (searchInput && searchInput.value) || "";
  if (!rawSearch && roleForSearch === "local" && operatorIdForSearch) {
    rawSearch = String(operatorIdForSearch);
  }
  const search = rawSearch.toLowerCase().trim();
  const normalizeFullName = (value) =>
    String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim()
      .replace(/\s+/g, " ");
  const normalizedSearch = normalizeFullName(rawSearch);
  let shift = (shiftFilter && shiftFilter.value) || "";
  const role =
    state.currentRole || window.sessionStorage.getItem("vacaciones_role");
  const isAdminLike = role === "admin" || role === "maestro";

  // Si se está escribiendo un ID numérico y se borra algún dígito
  // (menos de 4 dígitos), reseteamos inmediatamente los turnos.
  const isNumericTyping = /^[0-9]+$/.test(rawSearch.trim());
  if (isNumericTyping && rawSearch.trim().length < 4) {
    if (shiftFilter && shiftFilter.value !== "" && !isAdminLike) {
      shiftFilter.value = "";
    }
    shift = "";
  }

  // Nuevo comportamiento: SOLO mostramos datos si hay un operador seleccionado.
  // La selección se determina por búsqueda (idealmente por ID exacto).
  state.selectionMessage = "";

  // Si no hay búsqueda (ENTER sin ID/nombre): no mostramos ningún resultado,
  // sin importar el rol. Esto evita que se llenen las tablas automáticamente.
  if (!search) {
    state.filtered = [];
    // Al borrar o dejar vacío la búsqueda regresamos el turno a "Todos los turnos"
    if (shiftFilter) {
      shiftFilter.disabled = false;
      if (!isAdminLike && shiftFilter.value !== "") {
        shiftFilter.value = "";
      }
      // Mantener color placeholder coherente
      shiftFilter.style.color =
        shiftFilter.value === "" ? "rgb(150, 150, 150)" : "#000000";
    }
    shift = "";
    state.selectionMessage = "";
    renderOperatorsTable();
    renderAbsencesTable();
    renderApprovalsTable();
    renderAdminSavedRequestSummary();
    updateAdminOperatorPhotoCardVisibility();
    applyFiltersPortalLocalFechaSync();
    return;
  }

  /*
   * Admin / maestro: applyFilters() debe llamarse al pulsar Enter (init y notificaciones
   * también lo invocan). Con ID de exactamente 4 dígitos entre 1001 y 1500 → datos;
   * en cualquier otro caso → pantalla en blanco.
   */
  if (isAdminLike) {
    const soloDigitos = /^[0-9]+$/.test(search);
    let selected = null;
    if (soloDigitos) {
      const nId = Number(search);
      const idValido = /^[0-9]{4}$/.test(search) && nId >= 1001 && nId <= 1500;
      if (!idValido) {
        state.filtered = [];
        state.selectionMessage = "";
        if (shiftFilter) {
          shiftFilter.disabled = false;
          if (shiftFilter.value !== "") shiftFilter.value = "";
          shiftFilter.style.color = "rgb(150, 150, 150)";
        }
        shift = "";
        renderOperatorsTable();
        renderAbsencesTable();
        renderApprovalsTable();
        renderAdminSavedRequestSummary();
        updateAdminOperatorPhotoCardVisibility();
        applyFiltersPortalLocalFechaSync();
        return;
      }
      const index = nId - 1001;
      if (index >= 0 && index < state.operators.length) {
        selected = state.operators[index];
      }
    } else {
      selected =
        state.operators.find(
          (op) => normalizeFullName(op.nombreCompleto) === normalizedSearch
        ) || null;
      if (!selected) {
        state.filtered = [];
        state.selectionMessage =
          "No se encontró ningún operador con ese ID/nombre. Escribe el ID o nombre completo.";
        if (shiftFilter) {
          shiftFilter.disabled = false;
          if (shiftFilter.value !== "") shiftFilter.value = "";
          shiftFilter.style.color = "rgb(150, 150, 150)";
        }
        shift = "";
        renderOperatorsTable();
        renderAbsencesTable();
        renderApprovalsTable();
        renderAdminSavedRequestSummary();
        updateAdminOperatorPhotoCardVisibility();
        applyFiltersPortalLocalFechaSync();
        return;
      }
    }
    state.filtered = selected ? [selected] : [];
    state.selectionMessage = "";
    if (selected && shiftFilter) {
      shift = selected.turno;
      if (shiftFilter.value !== selected.turno) {
        shiftFilter.value = selected.turno;
      }
      shiftFilter.disabled = true;
      shiftFilter.style.color = "#000000";
    } else if (shiftFilter) {
      shiftFilter.disabled = false;
      if (shiftFilter.value !== "") shiftFilter.value = "";
      shiftFilter.style.color = "rgb(150, 150, 150)";
    }
    shift = selected ? selected.turno : "";
    renderOperatorsTable();
    renderAbsencesTable();
    renderApprovalsTable();
    renderAdminSavedRequestSummary();
    updateAdminOperatorPhotoCardVisibility();
    applyFiltersPortalLocalFechaSync();
    return;
  }

  const isNumericQuery = /^[0-9]+$/.test(search);

  // Validación de rango de IDs: sólo existen del 1001 al 1500 (portal local, etc.)
  let numericId = null;
  if (isNumericQuery) {
    numericId = Number(search);
    if (numericId < 1001 || numericId > 1500) {
      state.filtered = [];
      if (shiftFilter && shiftFilter.value !== "") {
        shiftFilter.value = "";
      }
      shift = "";
      const idIncompleto =
        isNumericQuery && search.length < 4 && numericId < 1001;
      state.selectionMessage = idIncompleto
        ? "Indica el ID completo (4 dígitos entre 1001 y 1500) o el nombre completo del operador."
        : "No se encontró ningún operador con ese ID/nombre. Escribe el ID o nombre completo.";
      renderOperatorsTable();
      renderAbsencesTable();
      renderApprovalsTable();
      renderAdminSavedRequestSummary();
      applyFiltersPortalLocalFechaSync();
      return;
    }
  }

  // Candidatos por turno (si aplica)
  // Importante: como la selección es por coincidencia exacta (ID/nombre completo),
  // no debe depender del turno previo para que al bloquear el selector podamos
  // seguir buscando otro operador con turno distinto.
  const pool = state.operators;

  // 1) Match por ID exacto (cuando sea numérico).
  //    Como sabemos que los IDs van de 1001 a 1500 y se generan en orden,
  //    podemos obtener directamente el operador por índice para garantizar
  //    que NINGÚN ID dentro del rango quede "vacío".
  let selected = null;
  if (isNumericQuery) {
    const index = numericId - 1001;
    if (index >= 0 && index < state.operators.length) {
      selected = state.operators[index];
    }
  }

  // 2) Match por nombre exacto (case-insensitive)
  if (!selected) {
    selected =
      pool.find((op) => normalizeFullName(op.nombreCompleto) === normalizedSearch) || null;
  }

  // Si no hay match exacto, NO seleccionamos a nadie (no aceptamos búsquedas parciales)
  if (!selected) {
    state.selectionMessage =
      "No se encontró ningún operador con ese ID/nombre. Escribe el ID o nombre completo.";
    // Sin resultado: reseteamos el turno a "Todos los turnos"
    if (shiftFilter) {
      shiftFilter.disabled = false;
      if (!isAdminLike && shiftFilter.value !== "") {
        shiftFilter.value = "";
      }
      shiftFilter.style.color =
        shiftFilter.value === "" ? "rgb(150, 150, 150)" : "#000000";
    }
    shift = "";
  }

  // Si encontramos operador, ajustamos el turno para que coincida (como antes, pero solo con selección)
  if (selected && shiftFilter) {
    shift = selected.turno;
    if (shiftFilter.value !== selected.turno) {
      shiftFilter.value = selected.turno;
    }
    shiftFilter.disabled = true;
    shiftFilter.style.color = "#000000";
  }

  state.filtered = selected ? [selected] : [];

  renderOperatorsTable();
  renderAbsencesTable();
  renderApprovalsTable();
  renderAdminSavedRequestSummary();

  // Usuario local: solo vaciar el selector si no hay operador; no rellenar con motivo del operador
  const roleAfter =
    state.currentRole || window.sessionStorage.getItem("vacaciones_role");
  if (roleAfter === "local") {
    const motivoSelect = document.getElementById("motivoSelectLocal");
    if (motivoSelect) {
      if (state.filtered.length !== 1) motivoSelect.value = "";
      updateMotivoSelectPlaceholderClass(motivoSelect);
    }
  }

  updateAdminOperatorPhotoCardVisibility();
  applyFiltersPortalLocalFechaSync();
}

function updateMotivoSelectPlaceholderClass(selectEl) {
  if (!selectEl) return;
  if (selectEl.value === "") {
    selectEl.classList.add("motivo-placeholder");
  } else {
    selectEl.classList.remove("motivo-placeholder");
  }
}

function init() {
  const searchInput = document.getElementById("searchInput");
  const shiftFilter = document.getElementById("shiftFilter");
  const detailContainer = document.getElementById("operatorDetailContent");

  if (!detailContainer) {
    console.error(
      "No se encontraron los elementos del DOM necesarios para la búsqueda de operadores."
    );
    document.body.innerHTML +=
      '<p style="color:red;padding:1rem;">Error: no se cargaron los elementos. Abre index.html desde la carpeta del proyecto (doble clic en index.html dentro de vacaciones-portal).</p>';
    return;
  }

  if (isAdminHtmlPage()) {
    resetAdminEphemeralPermisoActionUiLocks();
  }

  const role = window.sessionStorage.getItem("vacaciones_role");
  if (role) {
    document.body.classList.add("role-" + role);
  }
  setupHistoryPdfButtons();

  // Cambiar color del texto visible del selector "shiftFilter":
  // - placeholder ("Todos los turnos", value="") => gris
  // - opciones reales => negro
  function syncShiftFilterTextColor() {
    if (!shiftFilter) return;
    if (shiftFilter.value === "") {
      shiftFilter.style.color = "rgb(150, 150, 150)";
    } else {
      shiftFilter.style.color = "#000000";
    }
  }
  if (shiftFilter) {
    shiftFilter.addEventListener("change", syncShiftFilterTextColor);
    syncShiftFilterTextColor();
  }

  const operatorId =
    role === "local"
      ? window.sessionStorage.getItem("vacaciones_operator_id")
      : null;

  state.currentRole = role;
  state.currentOperatorId = operatorId;

  state.operators = generateOperators(500);
  state.filtered = [];
  updateAdminOperatorPhotoCardVisibility();

  const isAdminLike = role === "admin" || role === "maestro";

  // En admin.html, reflejar cambios guardados del portal en tiempo real (sin refresh manual).
  if (isAdminLike && !window.__adminSavedRequestStorageBound) {
    window.addEventListener("storage", refreshAdminSavedRequestOnStorageChange);
    window.__adminSavedRequestStorageBound = true;
  }

  const motivoTableWrap = document.getElementById("motivoTableWrap");
  const motivoSelectWrap = document.getElementById("motivoSelectWrap");

  // MAESTRO/ADMIN: puede buscar y filtrar libremente, y ve listado completo inicial
  if (isAdminLike) {
    if (motivoTableWrap) motivoTableWrap.style.display = "";
    if (motivoSelectWrap) motivoSelectWrap.style.display = "none";

    if (searchInput) {
      let lastAdminSearchValue = searchInput.value.trim();
      searchInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") applyFilters();
      });
      // Solo Enter ejecuta applyFilters(); al editar el ID sin Enter puede verse el
      // resultado anterior hasta el próximo Enter (válido = datos; inválido = vacío).
      searchInput.addEventListener("input", () => {
        if (!shiftFilter) return;
        const prevTrimmed = lastAdminSearchValue;
        const trimmed = searchInput.value.trim();
        const hadPreviousQuery = prevTrimmed !== "";
        const nowIsEmpty = trimmed === "";
        lastAdminSearchValue = trimmed;
        // admin.html: si se borra por completo la búsqueda (ID o nombre), limpiar de inmediato.
        if (isAdminHtmlPage() && hadPreviousQuery && nowIsEmpty) {
          applyFilters();
        }
        if (trimmed === "") {
          shiftFilter.disabled = false;
          if (shiftFilter.value !== "") shiftFilter.value = "";
          shiftFilter.style.color =
            shiftFilter.value === "" ? "rgb(150, 150, 150)" : "#000000";
        } else if (!isAdminHtmlPage()) {
          shiftFilter.disabled = false;
          shiftFilter.style.color =
            shiftFilter.value === "" ? "rgb(150, 150, 150)" : "#000000";
        } else {
          // admin.html: no reactivar «Todos los turnos» en cada tecla si ya hay texto
          // (el bloqueo tras seleccionar operador se mantiene hasta vaciar la búsqueda).
          shiftFilter.style.color =
            shiftFilter.value === "" ? "rgb(150, 150, 150)" : "#000000";
        }
      });
    }

    applyFilters();

    // Foto del operador (ADMIN/MAESTRO): permitir subir imagen en el recuadro.
    const operatorPhotoWrapAdmin = document.getElementById("operatorPhotoWrap");
    const operatorPhotoAdmin = document.getElementById("operatorPhoto");
    const operatorPhotoInputAdmin = document.getElementById("operatorPhotoInput");
    if (
      operatorPhotoWrapAdmin &&
      operatorPhotoAdmin &&
      operatorPhotoInputAdmin
    ) {
      operatorPhotoWrapAdmin.dataset.photoHandlersBound = "1";
      let lastOperatorPhotoObjectUrl = null;
      let ignoreNextOperatorPhotoInputClick = false;
      let ignoreNextOperatorPhotoWrapClick = false;

      const operatorPhotoPlaceholderAdmin =
        operatorPhotoWrapAdmin.querySelector(".operator-photo-placeholder");

      const clearOperatorPhotoAdmin = () => {
        if (lastOperatorPhotoObjectUrl) {
          URL.revokeObjectURL(lastOperatorPhotoObjectUrl);
          lastOperatorPhotoObjectUrl = null;
        }
        const opIdToClear = getCurrentOperatorIdForPhoto();
        if (opIdToClear) {
          window.localStorage.removeItem(operatorPhotoStorageKey(opIdToClear));
        }
        operatorPhotoAdmin.style.display = "";
        operatorPhotoAdmin.src = "";
        operatorPhotoAdmin.setAttribute("src", "");
        if (operatorPhotoPlaceholderAdmin)
          operatorPhotoPlaceholderAdmin.style.display = "flex";
        operatorPhotoInputAdmin.value = "";
      };

      operatorPhotoWrapAdmin.addEventListener("click", function () {
        if (ignoreNextOperatorPhotoWrapClick) return;
        const srcAttr = operatorPhotoAdmin.getAttribute("src") || "";
        const hasPhoto = srcAttr.trim() !== "";
        if (hasPhoto) {
          clearOperatorPhotoAdmin();
          return;
        }
      });

      operatorPhotoInputAdmin.addEventListener("click", function (event) {
        if (ignoreNextOperatorPhotoInputClick) {
          ignoreNextOperatorPhotoInputClick = false;
          return;
        }
        const srcAttr = operatorPhotoAdmin.getAttribute("src") || "";
        const hasPhoto = srcAttr.trim() !== "";
        if (!hasPhoto) return;
        event.preventDefault();
        event.stopPropagation();
        clearOperatorPhotoAdmin();
      });

      operatorPhotoInputAdmin.addEventListener("change", function () {
        ignoreNextOperatorPhotoInputClick = true;
        ignoreNextOperatorPhotoWrapClick = true;
        setTimeout(() => {
          ignoreNextOperatorPhotoInputClick = false;
          ignoreNextOperatorPhotoWrapClick = false;
        }, 300);

        const file =
          operatorPhotoInputAdmin.files &&
          operatorPhotoInputAdmin.files[0];
        if (!file) return;
        if (!file.type.startsWith("image/")) {
          alert("Por favor selecciona una imagen (.png, .jpg, etc.).");
          operatorPhotoInputAdmin.value = "";
          return;
        }

        const opIdToSave = getCurrentOperatorIdForPhoto();
        if (!opIdToSave) {
          alert("Selecciona un operador primero.");
          operatorPhotoInputAdmin.value = "";
          return;
        }
        const reader = new FileReader();
        reader.onload = function () {
          const dataUrl = typeof reader.result === "string" ? reader.result : "";
          if (!dataUrl) return;
          const oldSrc = operatorPhotoAdmin.getAttribute("src") || "";
          if (oldSrc.startsWith("blob:")) {
            try {
              URL.revokeObjectURL(oldSrc);
            } catch (e) {
              /* ignore */
            }
          }
          lastOperatorPhotoObjectUrl = null;
          window.localStorage.setItem(operatorPhotoStorageKey(opIdToSave), dataUrl);
          operatorPhotoAdmin.setAttribute("src", dataUrl);
          operatorPhotoAdmin.src = dataUrl;
          operatorPhotoAdmin.style.display = "block";
          if (operatorPhotoPlaceholderAdmin) {
            operatorPhotoPlaceholderAdmin.style.display = "none";
          }
        };
        reader.readAsDataURL(file);
      });
    }

    setupAdminPermisoDecisionButtons();
    setupAdminRequestHistoryToggle();
    setupAdminHistorialFirestoreScopeControls();
    setupAdminNotificationCenter();
    refreshAdminNotificationList();
  } else if (role === "local") {
    const localOperatorId = (
      window.sessionStorage.getItem("vacaciones_operator_id") || ""
    ).trim();
    if (localOperatorId) {
      runPortalVacationSaldoFirestoreReconcile(localOperatorId);
      startPortalVacationSaldoFirestoreLiveSync(localOperatorId);
      renderPortalVacationSaldoDebugInfo(localOperatorId);
    }

    // Enlazar primero sync entre pestañas / sondeo: si más abajo falla JSON.parse u otro paso,
    // el portal seguirá actualizando días disponibles tras reset en maestroop/admin.
    if (!window.__portalPermisoStatusBound) {
      window.__portalPermisoStatusBound = true;

      const syncPermisoIfCurrentOperator = (updatedOpId) => {
        const currentOid =
          window.sessionStorage.getItem("vacaciones_operator_id");
        if (
          !currentOid ||
          !updatedOpId ||
          String(updatedOpId) !== String(currentOid)
        ) {
          return;
        }
        refreshPortalPermisoStatusUI(currentOid);
      };

      function syncSaldoIfCurrentOperator(updatedOpId) {
        const currentOid =
          window.sessionStorage.getItem("vacaciones_operator_id");
        if (
          !currentOid ||
          !updatedOpId ||
          String(updatedOpId) !== String(currentOid)
        ) {
          return;
        }
        portalRefreshLocalVacationSaldoUIForOperator(currentOid);
      }

      window.addEventListener("storage", function (ev) {
        if (!ev.key) return;
        if (ev.key.indexOf("vacaciones_permiso_status_") === 0) {
          const idFromKey = ev.key.replace("vacaciones_permiso_status_", "");
          syncPermisoIfCurrentOperator(idFromKey);
          return;
        }
        if (ev.key.indexOf("vacaciones_saldo_nudge_") === 0) {
          const idFromKey = ev.key.replace("vacaciones_saldo_nudge_", "");
          syncSaldoIfCurrentOperator(idFromKey);
          return;
        }
        if (
          ev.key.indexOf("vacaciones_operador_vacaciones_consumidas_") === 0
        ) {
          const idFromKey = ev.key.replace(
            "vacaciones_operador_vacaciones_consumidas_",
            ""
          );
          syncSaldoIfCurrentOperator(idFromKey);
        }
      });

      try {
        if (typeof BroadcastChannel !== "undefined") {
          const bc = new BroadcastChannel(PERMISO_STATUS_BC);
          bc.onmessage = function (ev) {
            if (ev.data && ev.data.operatorId) {
              syncPermisoIfCurrentOperator(ev.data.operatorId);
            }
          };
          const bcSaldo = new BroadcastChannel(VACATION_SALDO_BC);
          bcSaldo.onmessage = function (ev) {
            if (ev.data && ev.data.operatorId) {
              syncSaldoIfCurrentOperator(ev.data.operatorId);
            }
          };
        }
      } catch (e) {
        /* ignore */
      }

      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState !== "visible") return;
        const oid = window.sessionStorage.getItem("vacaciones_operator_id");
        if (oid) {
          refreshPortalPermisoStatusUI(oid);
          runPortalVacationSaldoFirestoreReconcile(oid);
          portalPollLocalVacationSaldoIfChanged();
          renderPortalVacationSaldoDebugInfo(oid);
        }
      });
      window.addEventListener("focus", function () {
        const oid = window.sessionStorage.getItem("vacaciones_operator_id");
        if (oid) {
          refreshPortalPermisoStatusUI(oid);
          runPortalVacationSaldoFirestoreReconcile(oid);
          portalPollLocalVacationSaldoIfChanged();
          renderPortalVacationSaldoDebugInfo(oid);
        }
      });

      window.addEventListener("pageshow", function (ev) {
        const oid = window.sessionStorage.getItem("vacaciones_operator_id");
        if (oid) {
          refreshPortalPermisoStatusUI(oid);
          if (ev.persisted) {
            __portalSaldoPollLastSaldo = undefined;
          }
          runPortalVacationSaldoFirestoreReconcile(oid);
          portalPollLocalVacationSaldoIfChanged();
        }
      });

      const pollMs = 800;
      window.__portalPermisoPollTimer = window.setInterval(function () {
        if (document.hidden) return;
        const oid = window.sessionStorage.getItem("vacaciones_operator_id");
        if (!oid) return;
        const j = JSON.stringify(getPermisoStatus(oid));
        if (j !== __portalPermisoStatusLastJson) {
          refreshPortalPermisoStatusUI(oid);
        }
        portalPollLocalVacationSaldoIfChanged();
      }, pollMs);

      window.__portalSaldoFsReconcileTimer = window.setInterval(function () {
        if (document.hidden) return;
        const oid = window.sessionStorage.getItem("vacaciones_operator_id");
        if (oid) {
          runPortalVacationSaldoFirestoreReconcile(oid);
          startPortalVacationSaldoFirestoreLiveSync(oid);
        }
      }, 15000);
    }

    // USUARIO LOCAL: sólo puede ver su propia información; motivo como selector
    const welcomeMessageCard = document.getElementById("welcomeMessageCard");
    if (welcomeMessageCard) welcomeMessageCard.style.display = "block";

    if (motivoTableWrap) motivoTableWrap.style.display = "none";
    if (motivoSelectWrap) motivoSelectWrap.style.display = "block";

    // Mover "Motivo de ausencia" a donde estaba "No. de días solicitados" (fila media, antes de la columna de vacaciones)
    const motivoSection = document.getElementById("motivoSection");
    const layoutMiddleRow = document.querySelector(".layout-middle-row");
    const vacacionesColumna = document.querySelector(".vacaciones-columna");
    if (motivoSection && layoutMiddleRow && vacacionesColumna) {
      layoutMiddleRow.insertBefore(motivoSection, vacacionesColumna);
    }

    const motivoSelectLocal = document.getElementById("motivoSelectLocal");
    const vacacionesCard = document.getElementById("vacacionesCard");
    const fechasDisfrutarCard = document.getElementById("fechasDisfrutarCard");
    const guardarVacacionesWrap = document.getElementById("guardarVacacionesWrap");
    const faltaJustificadaColumna = document.getElementById("faltaJustificadaColumna");
    const fechaJustificarCard = document.getElementById("fechaJustificarCard");
    const permisoSinGoceColumna = document.getElementById("permisoSinGoceColumna");
    const fechaPermisoSinGoceCard = document.getElementById("fechaPermisoSinGoceCard");
    const permisoGoceCard = document.getElementById("permisoGoceCard");
    const fechasPermisoCard = document.getElementById("fechasPermisoCard");
    const guardarPermisoGoceWrap = document.getElementById("guardarPermisoGoceWrap");
    const portalFieldIdsByMotive = {
      "Vacaciones": [
        "diasSolicitadosInput",
        "fechaDiaSelect",
        "fechaMesSelect",
        "fechaAnioSelect",
        "fechaDiaSelectFin",
        "fechaMesSelectFin",
        "fechaAnioSelectFin",
      ],
      "Falta justificada": [
        "diasSolicitadosFaltaJustificadaInput",
        "fechaJustificarDiaSelect",
        "fechaJustificarMesSelect",
        "fechaJustificarAnioSelect",
        "fechaJustificarDiaSelectFin",
        "fechaJustificarMesSelectFin",
        "fechaJustificarAnioSelectFin",
        "motivoFaltaJustificadaInput",
      ],
      "Permiso sin goce": [
        "diasSolicitadosPermisoSinGoceInput",
        "fechaPermisoSinGoceDiaSelect",
        "fechaPermisoSinGoceMesSelect",
        "fechaPermisoSinGoceAnioSelect",
        "fechaPermisoSinGoceDiaSelectFin",
        "fechaPermisoSinGoceMesSelectFin",
        "fechaPermisoSinGoceAnioSelectFin",
        "motivoPermisoSinGoceInput",
      ],
      "Permiso con goce": [
        "permisoGoceSelect",
        "diasSolicitadosPermisoGoceInput",
        "fechaPermisoDiaSelect",
        "fechaPermisoMesSelect",
        "fechaPermisoAnioSelect",
        "fechaPermisoDiaSelectFin",
        "fechaPermisoMesSelectFin",
        "fechaPermisoAnioSelectFin",
      ],
    };

    function clearPortalDraftFieldsForMotivo(motivo) {
      const ids = portalFieldIdsByMotive[motivo];
      if (!ids || !ids.length) return;
      ids.forEach(function (id) {
        const el = document.getElementById(id);
        if (!el || el.disabled) return;
        if ("value" in el) el.value = "";
        const tag = (el.tagName || "").toLowerCase();
        const evName = tag === "select" ? "change" : "input";
        el.dispatchEvent(new Event(evName, { bubbles: true }));
      });
    }
    function updateCardsByMotivo() {
      if (!motivoSelectLocal) return;
      const val = motivoSelectLocal.value;
      document.body.classList.toggle(
        "portal-motivo-falta-o-permiso-sin-goce",
        val === "Falta justificada" || val === "Permiso sin goce"
      );
      if (vacacionesCard) {
        vacacionesCard.style.display = val === "Vacaciones" ? "block" : "none";
      }
      if (fechasDisfrutarCard) {
        fechasDisfrutarCard.style.display = val === "Vacaciones" ? "block" : "none";
      }
      if (guardarVacacionesWrap) {
        guardarVacacionesWrap.style.display = val === "Vacaciones" ? "block" : "none";
      }
      if (faltaJustificadaColumna) {
        faltaJustificadaColumna.style.display = val === "Falta justificada" ? "flex" : "none";
      }
      if (permisoSinGoceColumna) {
        permisoSinGoceColumna.style.display = val === "Permiso sin goce" ? "flex" : "none";
      }
      if (permisoGoceCard) {
        permisoGoceCard.style.display = val === "Permiso con goce" ? "block" : "none";
      }
      if (fechasPermisoCard) {
        fechasPermisoCard.style.display = val === "Permiso con goce" ? "block" : "none";
      }
      if (guardarPermisoGoceWrap) {
        guardarPermisoGoceWrap.style.display = val === "Permiso con goce" ? "flex" : "none";
      }
      syncPortalDiasDisponiblesLabels();
    }

    // Si se llegó a la pestaña con modo "locked", cargar los datos guardados y deshabilitar todo.
    let lockedValuesToApply = null;
    const operatorScopeId = resolvePortalOperatorScopeId() || "global";
    const lockedModeSessionKey = `vacaciones_locked_mode_${operatorScopeId}`;
    const lockedPayloadSessionKey = `vacaciones_locked_payload_${operatorScopeId}`;
    const lockedRequiredSessionKey = `vacaciones_locked_required_ids_${operatorScopeId}`;
    const lockedModeLocalKey = `vacaciones_last_saved_locked_mode_${operatorScopeId}`;
    const lockedPayloadLocalKey = `vacaciones_last_saved_payload_${operatorScopeId}`;


    clearPortalModificarCambiosActiveForAdminLock(operatorScopeId);

    // localStorage es compartido entre pestañas; sessionStorage no. Si el maestro hace RESET
    // en otra pestaña, aquí desaparece local pero esta pestaña puede seguir con session "locked".
    // Sin copia persistida válida, limpiamos session para alinear con el reset.
    const persistentLockedModeFlag = window.localStorage.getItem(lockedModeLocalKey);
    const persistentPayloadRaw = window.localStorage.getItem(lockedPayloadLocalKey);
    const hasValidPersistentLock =
      persistentLockedModeFlag === "1" &&
      typeof persistentPayloadRaw === "string" &&
      persistentPayloadRaw.trim() !== "";

    if (!hasValidPersistentLock) {
      window.sessionStorage.removeItem(lockedModeSessionKey);
      window.sessionStorage.removeItem(lockedPayloadSessionKey);
      window.sessionStorage.removeItem(lockedRequiredSessionKey);
      if (operatorScopeId !== "global") {
        reconcileHistoryArchivadaWhenSavedSolicitudMissing(operatorScopeId);
        try {
          maybeRenderPortalRequestHistory();
        } catch (e) {
          /* ignore */
        }
      }
    }

    let lockedModeFlag = window.sessionStorage.getItem(lockedModeSessionKey);
    const isLockedTab =
      lockedModeFlag === "1" || hasValidPersistentLock;
    let lockedPayloadRaw = window.sessionStorage.getItem(lockedPayloadSessionKey);
    if (!lockedPayloadRaw && hasValidPersistentLock) {
      lockedPayloadRaw = persistentPayloadRaw;
      // Si viene de localStorage, rehidratar sesión actual.
      if (lockedPayloadRaw) {
        window.sessionStorage.setItem(lockedModeSessionKey, "1");
        window.sessionStorage.setItem(lockedPayloadSessionKey, lockedPayloadRaw);
        lockedModeFlag = "1";
      }
    }

    // Otra pestaña borró el respaldo local (RESET maestro): limpiar bloqueo en vivo.
    window.addEventListener("storage", function onVacacionesStorage(ev) {
      const opId = resolvePortalOperatorScopeId() || "global";
      const modeKey = `vacaciones_last_saved_locked_mode_${opId}`;
      const payKey = `vacaciones_last_saved_payload_${opId}`;
      if (ev.key !== modeKey && ev.key !== payKey) return;
      const lm = window.localStorage.getItem(modeKey);
      const pr = window.localStorage.getItem(payKey);
      const still =
        lm === "1" &&
        typeof pr === "string" &&
        pr.trim() !== "";
      if (still) return;
      window.sessionStorage.removeItem(`vacaciones_locked_mode_${opId}`);
      window.sessionStorage.removeItem(`vacaciones_locked_payload_${opId}`);
      window.sessionStorage.removeItem(`vacaciones_locked_required_ids_${opId}`);
      window.location.reload();
    });

    // Si NO estamos en modo locked, limpiar payload viejo para evitar
    // que se muestren datos guardados de otra persona.
    if (!isLockedTab) {
      document.body.classList.remove("locked-mode");
      window.sessionStorage.removeItem(lockedModeSessionKey);
      window.sessionStorage.removeItem(lockedPayloadSessionKey);
      window.sessionStorage.removeItem(lockedRequiredSessionKey);
    }
    if (isLockedTab) {
      // Asegurar también el cambio visual del botón "Modificar cambios"
      document.body.classList.add("locked-mode");
    }
    // Si ya hay una solicitud guardada/bloqueada, mantener reflejado el descuento en "No. de días disponibles".
    portalSaldoDescontarInputEnabled = !!isLockedTab;
    if (isLockedTab && lockedPayloadRaw) {
      let payload = null;
      try {
        payload = JSON.parse(lockedPayloadRaw);
      } catch (e) {
        payload = null;
      }
      if (payload) {
        const motivo = payload && payload.motive ? payload.motive : "";
        const values = (payload && payload.values) || {};
        const requiredIds = payload && payload.requiredIds ? payload.requiredIds : [];

        if (motivoSelectLocal && motivo) {
          motivoSelectLocal.value = motivo;
        }

        updateCardsByMotivo();

        lockedValuesToApply = values;

        const lockIds = (ids) => {
          (ids || []).forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.disabled = true;
          });
        };

        const idsToLock = requiredIds.length ? requiredIds : Object.keys(values);
        lockIds(idsToLock);
        if (motivoSelectLocal) motivoSelectLocal.disabled = true;

        const motivoSectionEl = document.getElementById("motivoSection");
        const motivoSelectWrapEl = document.getElementById("motivoSelectWrap");
        if (motivoSelectWrapEl) {
          motivoSelectWrapEl.style.pointerEvents = "none";
          motivoSelectWrapEl.querySelectorAll("select, input, textarea, button").forEach((el) => {
            el.disabled = true;
          });
        }
        if (motivoSectionEl) {
          motivoSectionEl.style.pointerEvents = "none";
        }

        const btnMap = {
          "Vacaciones": "btnGuardarVacaciones",
          "Falta justificada": "btnGuardarFaltaJustificada",
          "Permiso sin goce": "btnGuardarPermisoSinGoce",
          "Permiso con goce": "btnGuardarPermisoGoce",
        };
        const btnToLockId = btnMap[motivo];
        if (btnToLockId) {
          const btn = document.getElementById(btnToLockId);
          if (btn) btn.disabled = true;
        }
      }
    }

    // "Modificar cambios": desbloquear lo que se bloqueó (solo cuando ya está bloqueado)
    const tryUnlockFromModifyChanges = function () {
      const lockedPayloadRaw = window.sessionStorage.getItem(
        lockedPayloadSessionKey
      );
      const lockedModeFlag = window.sessionStorage.getItem(
        lockedModeSessionKey
      );
      if (document.body.classList.contains("locked-mode") !== true) return;
      if (!lockedPayloadRaw || lockedModeFlag !== "1") return;

      let payload = null;
      try {
        payload = JSON.parse(lockedPayloadRaw);
      } catch (e) {
        payload = null;
      }
      if (!payload) return;

      const requiredIds =
        payload && payload.requiredIds ? payload.requiredIds : [];
      const values = (payload && payload.values) || {};
      const idsToUnlock = requiredIds.length ? requiredIds : Object.keys(values);

      // Quitar modo bloqueado visual
      document.body.classList.remove("locked-mode");
      portalSaldoDescontarInputEnabled = false;
      portalSaldoWarningEnabled = false;

      // Ya no usamos hash para el bloqueo, solo el flag en sessionStorage.

      // Habilitar campos
      idsToUnlock.forEach(function (id) {
        const el = document.getElementById(id);
        if (el) el.disabled = false;
      });

      // Habilitar "Motivo de ausencia" recuadro + selector (si existe)
      const motivoSectionEl = document.getElementById("motivoSection");
      const motivoSelectWrapEl = document.getElementById("motivoSelectWrap");
      const motivoSelectLocalEl = document.getElementById("motivoSelectLocal");
      if (motivoSectionEl) motivoSectionEl.style.pointerEvents = "auto";
      if (motivoSelectWrapEl) motivoSelectWrapEl.style.pointerEvents = "auto";
      if (motivoSelectLocalEl) motivoSelectLocalEl.disabled = false;
      if (motivoSelectWrapEl) {
        motivoSelectWrapEl
          .querySelectorAll("select, input, textarea, button")
          .forEach((el) => {
            el.disabled = false;
          });
      }

      // Limpiar datos seleccionados (dejar placeholders: "Seleccionar motivo", etc.)
      if (motivoSelectLocalEl) {
        motivoSelectLocalEl.value = "";
        if (typeof updateMotivoSelectPlaceholderClass === "function") {
          updateMotivoSelectPlaceholderClass(motivoSelectLocalEl);
        }
      }

      idsToUnlock.forEach(function (id) {
        const el = document.getElementById(id);
        if (!el) return;
        const tag = (el.tagName || "").toLowerCase();
        if (tag === "select") {
          el.value = "";
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          el.value = "";
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });

      const diasSolicitadosErrorEl = document.getElementById("diasSolicitadosError");
      if (diasSolicitadosErrorEl) diasSolicitadosErrorEl.textContent = "";
      const diasPgErrorEl = document.getElementById(
        "diasSolicitadosPermisoGoceError"
      );
      if (diasPgErrorEl) diasPgErrorEl.textContent = "";
      const diasFjErrorEl = document.getElementById(
        "diasSolicitadosFaltaJustificadaError"
      );
      if (diasFjErrorEl) diasFjErrorEl.textContent = "";
      const diasSgErrorEl = document.getElementById(
        "diasSolicitadosPermisoSinGoceError"
      );
      if (diasSgErrorEl) diasSgErrorEl.textContent = "";

      // Habilitar botones "Guardar cambios"
      [
        "btnGuardarVacaciones",
        "btnGuardarFaltaJustificada",
        "btnGuardarPermisoSinGoce",
        "btnGuardarPermisoGoce",
      ].forEach(function (btnId) {
        const btn = document.getElementById(btnId);
        if (btn) btn.disabled = false;
      });

      // Asegurar que "Modificar cambios" quede habilitado también
      document.querySelectorAll(".btn-modif-cambios").forEach((b) => {
        b.disabled = false;
      });

      // Limpiar sessionStorage del bloqueo
      window.sessionStorage.removeItem(lockedModeSessionKey);
      window.sessionStorage.removeItem(lockedPayloadSessionKey);
      window.sessionStorage.removeItem(lockedRequiredSessionKey);
      // NO borrar localStorage: se conserva la última solicitud guardada
      // para que, si el operador sale o refresca durante modificación,
      // reaparezca la información previamente guardada.

      // Recalcular visible cards por el motivo actual (debe quedar en vacío)
      if (typeof updateCardsByMotivo === "function") {
        updateCardsByMotivo();
      }

      syncPortalModificarCambiosButtonsVisibility(operatorScopeId);
      setPortalModificarCambiosActiveForAdminLock(operatorScopeId);
      syncPortalRequestFlowUI(operatorScopeId);
    };

    document.querySelectorAll(".btn-modif-cambios").forEach((btn) => {
      btn.addEventListener("click", function () {
        const lockedPayloadRaw = window.sessionStorage.getItem(
          lockedPayloadSessionKey
        );
        const lockedModeFlag = window.sessionStorage.getItem(
          lockedModeSessionKey
        );
        const isLockedNow =
          document.body.classList.contains("locked-mode") &&
          lockedModeFlag === "1" &&
          !!lockedPayloadRaw;

        if (!isLockedNow) return;

        showConfirmModifyModal(function () {
          tryUnlockFromModifyChanges();
        });
      });
    });

    let lastSelectedMotivo = motivoSelectLocal ? motivoSelectLocal.value : "";
    if (motivoSelectLocal) {
      motivoSelectLocal.addEventListener("change", function () {
        const nextMotivo = motivoSelectLocal.value;
        // Antes de guardar: al cambiar de motivo, descartar borrador del motivo anterior.
        if (
          !document.body.classList.contains("locked-mode") &&
          lastSelectedMotivo &&
          lastSelectedMotivo !== nextMotivo
        ) {
          clearPortalDraftFieldsForMotivo(lastSelectedMotivo);
        }
        updateMotivoSelectPlaceholderClass(motivoSelectLocal);
        updateCardsByMotivo();
        portalSaldoDescontarInputEnabled = false;
        portalSaldoWarningEnabled = false;
        syncPortalDiasDisponiblesLabels();
        lastSelectedMotivo = nextMotivo;
      });
      updateMotivoSelectPlaceholderClass(motivoSelectLocal);
    }
    updateCardsByMotivo();

    bindPortalDiasSolicitadosInputConSync(
      "diasSolicitadosInput",
      "diasSolicitadosError"
    );
    bindPortalDiasSolicitadosInputConSync(
      "diasSolicitadosPermisoGoceInput",
      null,
      { silentDiasField: true }
    );
    bindPortalDiasSolicitadosInputConSync(
      "diasSolicitadosFaltaJustificadaInput",
      null,
      { silentDiasField: true }
    );
    bindPortalDiasSolicitadosInputConSync(
      "diasSolicitadosPermisoSinGoceInput",
      null,
      { silentDiasField: true }
    );

    // Guardar cambios: valida campos obligatorios del motivo y luego bloquea.
    function lockSectionFields(ids) {
      ids.forEach(function (id) {
        const el = document.getElementById(id);
        if (el) el.disabled = true;
      });
    }

    // Bloquear "Motivo de ausencia" recuadro + selector (para que no se pueda cambiar)
    function lockMotivoAusenciaSection() {
      const motivoSectionEl = document.getElementById("motivoSection");
      const motivoSelectWrapEl = document.getElementById("motivoSelectWrap");
      const motivoSelectLocalEl = document.getElementById("motivoSelectLocal");

      if (motivoSectionEl) motivoSectionEl.style.pointerEvents = "none";
      if (motivoSelectWrapEl) motivoSelectWrapEl.style.pointerEvents = "none";

      if (motivoSelectLocalEl) motivoSelectLocalEl.disabled = true;

      // Por seguridad, deshabilitar controles dentro del wrap
      if (motivoSelectWrapEl) {
        motivoSelectWrapEl
          .querySelectorAll("select, input, textarea, button")
          .forEach((el) => {
            el.disabled = true;
          });
      }
    }

    function isFieldFilled(el) {
      if (!el) return false;
      const tag = (el.tagName || "").toLowerCase();
      if (tag === "select") return String(el.value || "").trim() !== "";
      // input/textarea
      return String(el.value || "").trim() !== "";
    }

    function showMissingFieldsModal() {
      const existing = document.getElementById("missingFieldsModal");
      if (existing) existing.remove();

      const overlay = document.createElement("div");
      overlay.id = "missingFieldsModal";
      overlay.style.position = "fixed";
      overlay.style.inset = "0";
      overlay.style.background = "rgba(0,0,0,0.25)";
      overlay.style.display = "flex";
      overlay.style.alignItems = "center";
      overlay.style.justifyContent = "center";
      overlay.style.zIndex = "9999";

      const box = document.createElement("div");
      box.style.background = "#ffffff";
      box.style.border = "1px solid #cccccc";
      box.style.borderRadius = "14px";
      box.style.padding = "18px 20px";
      box.style.width = "min(380px, 92vw)";

      const text = document.createElement("div");
      text.textContent = "Completa todos los campos para continuar.";
      text.style.color = "#000000";
      text.style.fontSize = "0.95rem";
      text.style.lineHeight = "1.4";
      text.style.marginBottom = "14px";

      const acceptBtn = document.createElement("button");
      acceptBtn.type = "button";
      acceptBtn.textContent = "Aceptar";
      acceptBtn.style.border = "none";
      acceptBtn.style.borderRadius = "999px";
      acceptBtn.style.padding = "8px 18px";
      acceptBtn.style.background = "#31305a";
      acceptBtn.style.color = "#ffffff";
      acceptBtn.style.cursor = "pointer";
      acceptBtn.style.fontSize = "0.9rem";
      acceptBtn.style.display = "block";
      acceptBtn.style.margin = "0 auto";

      acceptBtn.addEventListener("click", function () {
        overlay.remove();
      });

      box.appendChild(text);
      box.appendChild(acceptBtn);
      overlay.appendChild(box);

      document.body.appendChild(overlay);
    }

    function showConfirmChangesModal(onAccept) {
      const existing = document.getElementById("confirmChangesModal");
      if (existing) existing.remove();

      const overlay = document.createElement("div");
      overlay.id = "confirmChangesModal";
      overlay.style.position = "fixed";
      overlay.style.inset = "0";
      overlay.style.background = "rgba(0,0,0,0.25)";
      overlay.style.display = "flex";
      overlay.style.alignItems = "center";
      overlay.style.justifyContent = "center";
      overlay.style.zIndex = "9999";

      const box = document.createElement("div");
      box.style.background = "#ffffff";
      box.style.border = "1px solid #cccccc";
      box.style.borderRadius = "14px";
      box.style.padding = "18px 20px";
      box.style.width = "min(420px, 92vw)";

      const text = document.createElement("div");
      text.textContent = "¿Seguro que deseas continuar con los cambios?";
      text.style.color = "#000000";
      text.style.fontSize = "0.95rem";
      text.style.lineHeight = "1.4";
      text.style.marginBottom = "14px";

      const actions = document.createElement("div");
      actions.style.display = "flex";
      actions.style.alignItems = "center";
      actions.style.justifyContent = "center";
      actions.style.gap = "12px";

      const acceptBtn = document.createElement("button");
      acceptBtn.type = "button";
      acceptBtn.textContent = "Aceptar";
      acceptBtn.style.border = "none";
      acceptBtn.style.borderRadius = "999px";
      acceptBtn.style.padding = "8px 18px";
      acceptBtn.style.background = "#31305a";
      acceptBtn.style.color = "#ffffff";
      acceptBtn.style.cursor = "pointer";
      acceptBtn.style.fontSize = "0.9rem";

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.textContent = "Cancelar";
      cancelBtn.style.border = "none";
      cancelBtn.style.borderRadius = "999px";
      cancelBtn.style.padding = "8px 18px";
      cancelBtn.style.background = "#e5e7eb";
      cancelBtn.style.color = "#000000";
      cancelBtn.style.cursor = "pointer";
      cancelBtn.style.fontSize = "0.9rem";

      acceptBtn.addEventListener("click", function () {
        overlay.remove();
        if (typeof onAccept === "function") onAccept();
      });

      cancelBtn.addEventListener("click", function () {
        overlay.remove();
      });

      actions.appendChild(acceptBtn);
      actions.appendChild(cancelBtn);
      box.appendChild(text);
      box.appendChild(actions);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
    }

    function showConfirmModifyModal(onAccept) {
      const existing = document.getElementById("confirmModifyModal");
      if (existing) existing.remove();

      const overlay = document.createElement("div");
      overlay.id = "confirmModifyModal";
      overlay.style.position = "fixed";
      overlay.style.inset = "0";
      overlay.style.background = "rgba(0,0,0,0.25)";
      overlay.style.display = "flex";
      overlay.style.alignItems = "center";
      overlay.style.justifyContent = "center";
      overlay.style.zIndex = "9999";

      const box = document.createElement("div");
      box.style.background = "#ffffff";
      box.style.border = "1px solid #cccccc";
      box.style.borderRadius = "14px";
      box.style.padding = "18px 20px";
      box.style.width = "min(420px, 92vw)";

      const text = document.createElement("div");
      text.textContent = "¿Seguro que deseas realizar modificaciones?";
      text.style.color = "#000000";
      text.style.fontSize = "0.95rem";
      text.style.lineHeight = "1.4";
      text.style.marginBottom = "14px";

      const actions = document.createElement("div");
      actions.style.display = "flex";
      actions.style.alignItems = "center";
      actions.style.justifyContent = "center";
      actions.style.gap = "12px";

      const acceptBtn = document.createElement("button");
      acceptBtn.type = "button";
      acceptBtn.textContent = "Aceptar";
      acceptBtn.style.border = "none";
      acceptBtn.style.borderRadius = "999px";
      acceptBtn.style.padding = "8px 18px";
      acceptBtn.style.background = "#31305a";
      acceptBtn.style.color = "#ffffff";
      acceptBtn.style.cursor = "pointer";
      acceptBtn.style.fontSize = "0.9rem";

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.textContent = "Cancelar";
      cancelBtn.style.border = "none";
      cancelBtn.style.borderRadius = "999px";
      cancelBtn.style.padding = "8px 18px";
      cancelBtn.style.background = "#e5e7eb";
      cancelBtn.style.color = "#000000";
      cancelBtn.style.cursor = "pointer";
      cancelBtn.style.fontSize = "0.9rem";

      acceptBtn.addEventListener("click", function () {
        overlay.remove();
        if (typeof onAccept === "function") onAccept();
      });

      cancelBtn.addEventListener("click", function () {
        overlay.remove();
      });

      actions.appendChild(acceptBtn);
      actions.appendChild(cancelBtn);
      box.appendChild(text);
      box.appendChild(actions);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
    }

    // Persistir la información a guardar en sessionStorage y abrirla en una nueva pestaña.
    function persistLockedInfoAndOpenTab(requiredIds) {
      const motive = motivoSelectLocal ? motivoSelectLocal.value : "";
      const values = {};
      requiredIds.forEach(function (id) {
        const el = document.getElementById(id);
        values[id] = el ? el.value : "";
      });

      const payloadToStore = {
        motive: motive,
        requiredIds: requiredIds,
        values: values,
      };

      window.sessionStorage.setItem(
        lockedModeSessionKey,
        "1"
      );
      window.sessionStorage.setItem(
        lockedPayloadSessionKey,
        JSON.stringify(payloadToStore)
      );
      // Persistencia adicional: conservar última información guardada
      // incluso si se cierra sesión o se recarga el portal.
      window.localStorage.setItem(lockedModeLocalKey, "1");
      window.localStorage.setItem(
        lockedPayloadLocalKey,
        JSON.stringify(payloadToStore)
      );

      // Historial de solicitudes por operador (incluye modificaciones).
      if (operatorScopeId && operatorScopeId !== "global") {
        const tipo = "Solicitud";
        const tsPush = Date.now();
        try {
          let history = getAdminRequestHistory(String(operatorScopeId));
          history.push({
            ts: tsPush,
            tipo,
            payload: payloadToStore,
          });
          history = history.slice(-25);
          setAdminRequestHistory(String(operatorScopeId), history);
          syncAdminRequestHistoryEstados(String(operatorScopeId));
        } catch (e) {
          /* ignore */
        }
        // Respaldo central en Firestore (no bloquea la experiencia local).
        backupPortalRequestToFirestore(
          String(operatorScopeId),
          payloadToStore,
          tipo
        ).then(function (folio) {
          if (!folio) return;
          try {
            const oid = String(operatorScopeId);
            let h2 = getAdminRequestHistory(oid);
            const ix = h2.findIndex(function (e) {
              return e && Number(e.ts) === Number(tsPush);
            });
            if (ix < 0) return;
            const cur = h2[ix];
            if (cur && cur.firestoreFolio) return;
            h2 = h2.slice();
            h2[ix] = Object.assign({}, cur, {
              firestoreFolio: String(folio),
            });
            setAdminRequestHistory(oid, h2);
          } catch (e2) {
            /* ignore */
          }
        });
      }

      clearPortalModificarCambiosActiveForAdminLock(operatorScopeId);
      const oidSession = (
        window.sessionStorage.getItem("vacaciones_operator_id") || ""
      ).trim();
      if (oidSession) {
        clearAdminSavedDecisionLocked(oidSession);
        clearAdminModifEstadoSession(oidSession);
      }
      clearAdminSavedDecisionLocked(operatorScopeId);
      clearAdminModifEstadoSession(operatorScopeId);
      // No redirigimos ni cambiamos el hash:
      // el bloqueo se aplica en la misma página al aceptar.
    }

    const btnGuardarVacaciones = document.getElementById("btnGuardarVacaciones");
    const btnGuardarFaltaJustificada = document.getElementById("btnGuardarFaltaJustificada");
    const btnGuardarPermisoSinGoce = document.getElementById("btnGuardarPermisoSinGoce");
    const btnGuardarPermisoGoce = document.getElementById("btnGuardarPermisoGoce");

    if (btnGuardarVacaciones) {
      btnGuardarVacaciones.addEventListener("click", function () {
        if (getPortalDiasDisponiblesParaEtiquetaPortal() <= 0) {
          enablePortalSaldoWarning();
          return;
        }
        const requiredIds = [
          "diasSolicitadosInput",
          "fechaDiaSelect", "fechaMesSelect", "fechaAnioSelect",
          "fechaDiaSelectFin", "fechaMesSelectFin", "fechaAnioSelectFin"
        ];

        const allFilled = requiredIds.every(function (id) {
          return isFieldFilled(document.getElementById(id));
        });

        if (!allFilled) {
          showMissingFieldsModal();
          return;
        }

        showConfirmChangesModal(function () {
          enablePortalSaldoWarningWithDiscount();
          persistLockedInfoAndOpenTab(requiredIds);
          document.body.classList.add("locked-mode");
          lockMotivoAusenciaSection();
          lockSectionFields(requiredIds);
          btnGuardarVacaciones.disabled = true;
          syncPortalRequestFlowUI(operatorScopeId);
        });
      });
    }

    if (btnGuardarFaltaJustificada) {
      btnGuardarFaltaJustificada.addEventListener("click", function () {
        if (getPortalDiasDisponiblesParaEtiquetaPortal() <= 0) {
          enablePortalSaldoWarning();
          return;
        }
        const requiredIds = [
          "diasSolicitadosFaltaJustificadaInput",
          "fechaJustificarDiaSelect", "fechaJustificarMesSelect", "fechaJustificarAnioSelect",
          "fechaJustificarDiaSelectFin", "fechaJustificarMesSelectFin", "fechaJustificarAnioSelectFin",
          "motivoFaltaJustificadaInput"
        ];

        const allFilled = requiredIds.every(function (id) {
          return isFieldFilled(document.getElementById(id));
        });

        if (!allFilled) {
          showMissingFieldsModal();
          return;
        }

        showConfirmChangesModal(function () {
          enablePortalSaldoWarningWithDiscount();
          persistLockedInfoAndOpenTab(requiredIds);
          document.body.classList.add("locked-mode");
          lockMotivoAusenciaSection();
          lockSectionFields(requiredIds);
          btnGuardarFaltaJustificada.disabled = true;
          syncPortalRequestFlowUI(operatorScopeId);
        });
      });
    }

    if (btnGuardarPermisoSinGoce) {
      btnGuardarPermisoSinGoce.addEventListener("click", function () {
        if (getPortalDiasDisponiblesParaEtiquetaPortal() <= 0) {
          enablePortalSaldoWarning();
          return;
        }
        const requiredIds = [
          "diasSolicitadosPermisoSinGoceInput",
          "fechaPermisoSinGoceDiaSelect", "fechaPermisoSinGoceMesSelect", "fechaPermisoSinGoceAnioSelect",
          "fechaPermisoSinGoceDiaSelectFin", "fechaPermisoSinGoceMesSelectFin", "fechaPermisoSinGoceAnioSelectFin",
          "motivoPermisoSinGoceInput"
        ];

        const allFilled = requiredIds.every(function (id) {
          return isFieldFilled(document.getElementById(id));
        });

        if (!allFilled) {
          showMissingFieldsModal();
          return;
        }

        showConfirmChangesModal(function () {
          enablePortalSaldoWarningWithDiscount();
          persistLockedInfoAndOpenTab(requiredIds);
          document.body.classList.add("locked-mode");
          lockMotivoAusenciaSection();
          lockSectionFields(requiredIds);
          btnGuardarPermisoSinGoce.disabled = true;
          syncPortalRequestFlowUI(operatorScopeId);
        });
      });
    }

    if (btnGuardarPermisoGoce) {
      btnGuardarPermisoGoce.addEventListener("click", function () {
        if (getPortalDiasDisponiblesParaEtiquetaPortal() <= 0) {
          enablePortalSaldoWarning();
          return;
        }
        const requiredIds = [
          "permisoGoceSelect",
          "diasSolicitadosPermisoGoceInput",
          "fechaPermisoDiaSelect", "fechaPermisoMesSelect", "fechaPermisoAnioSelect",
          "fechaPermisoDiaSelectFin", "fechaPermisoMesSelectFin", "fechaPermisoAnioSelectFin"
        ];

        const allFilled = requiredIds.every(function (id) {
          return isFieldFilled(document.getElementById(id));
        });

        if (!allFilled) {
          showMissingFieldsModal();
          return;
        }

        showConfirmChangesModal(function () {
          enablePortalSaldoWarningWithDiscount();
          persistLockedInfoAndOpenTab(requiredIds);
          document.body.classList.add("locked-mode");
          lockMotivoAusenciaSection();
          lockSectionFields(requiredIds);
          btnGuardarPermisoGoce.disabled = true;
          syncPortalRequestFlowUI(operatorScopeId);
        });
      });
    }

    // Foto del operador en portal local: espejo no interactivo de admin.html
    const operatorPhotoWrap = document.getElementById("operatorPhotoWrap");
    const operatorPhoto = document.getElementById("operatorPhoto");
    const operatorPhotoInput = document.getElementById("operatorPhotoInput");
    if (
      operatorPhotoWrap &&
      operatorPhoto &&
      operatorPhotoInput &&
      role === "local"
    ) {
      operatorPhotoWrap.dataset.photoHandlersBound = "1";
      const placeholder = operatorPhotoWrap.querySelector(".operator-photo-placeholder");
      if (placeholder) {
        placeholder.textContent = "Vacío";
        placeholder.style.pointerEvents = "none";
      }
      operatorPhotoWrap.style.cursor = "default";
      operatorPhotoInput.disabled = true;
      operatorPhotoInput.tabIndex = -1;
      operatorPhotoInput.style.pointerEvents = "none";
      operatorPhotoInput.setAttribute("aria-hidden", "true");
      const localOpId = getCurrentOperatorIdForPhoto();
      if (localOpId) renderOperatorPhotoFromStorage(localOpId);
      if (!window.__portalPhotoMirrorStorageBound) {
        window.addEventListener("storage", function (ev) {
          const currentOpId = getCurrentOperatorIdForPhoto();
          if (!currentOpId) return;
          const photoKey = operatorPhotoStorageKey(currentOpId);
          if (ev.key !== photoKey) return;
          renderOperatorPhotoFromStorage(currentOpId);
        });
        window.__portalPhotoMirrorStorageBound = true;
      }
    }

    setupPortalPostApproveActions();
    setupPortalRequestHistoryToggle();

    const fechaDiaSelect = document.getElementById("fechaDiaSelect");
    const fechaMesSelect = document.getElementById("fechaMesSelect");
    const fechaAnioSelect = document.getElementById("fechaAnioSelect");
    const fechaDiaSelectFin = document.getElementById("fechaDiaSelectFin");
    const fechaMesSelectFin = document.getElementById("fechaMesSelectFin");
    const fechaAnioSelectFin = document.getElementById("fechaAnioSelectFin");

    // Selectores de "Fechas del permiso" (Permiso con goce)
    const fechaPermisoDiaSelect = document.getElementById("fechaPermisoDiaSelect");
    const fechaPermisoMesSelect = document.getElementById("fechaPermisoMesSelect");
    const fechaPermisoAnioSelect = document.getElementById("fechaPermisoAnioSelect");
    const fechaPermisoDiaSelectFin = document.getElementById("fechaPermisoDiaSelectFin");
    const fechaPermisoMesSelectFin = document.getElementById("fechaPermisoMesSelectFin");
    const fechaPermisoAnioSelectFin = document.getElementById("fechaPermisoAnioSelectFin");

    // Selectores de "Fechas a justificar" (Falta justificada)
    const fechaJustificarDiaSelect = document.getElementById("fechaJustificarDiaSelect");
    const fechaJustificarMesSelect = document.getElementById("fechaJustificarMesSelect");
    const fechaJustificarAnioSelect = document.getElementById("fechaJustificarAnioSelect");
    const fechaJustificarDiaSelectFin = document.getElementById("fechaJustificarDiaSelectFin");
    const fechaJustificarMesSelectFin = document.getElementById("fechaJustificarMesSelectFin");
    const fechaJustificarAnioSelectFin = document.getElementById("fechaJustificarAnioSelectFin");

    // Selectores de "Fecha del permiso" (Permiso sin goce)
    const fechaPermisoSinGoceDiaSelect = document.getElementById("fechaPermisoSinGoceDiaSelect");
    const fechaPermisoSinGoceMesSelect = document.getElementById("fechaPermisoSinGoceMesSelect");
    const fechaPermisoSinGoceAnioSelect = document.getElementById("fechaPermisoSinGoceAnioSelect");
    const fechaPermisoSinGoceDiaSelectFin = document.getElementById("fechaPermisoSinGoceDiaSelectFin");
    const fechaPermisoSinGoceMesSelectFin = document.getElementById("fechaPermisoSinGoceMesSelectFin");
    const fechaPermisoSinGoceAnioSelectFin = document.getElementById("fechaPermisoSinGoceAnioSelectFin");

    // Modo locked: mes/año (y demás) primero; día después de rellenar opciones por mes.
    applyPortalLockedFieldValuesExcludingDia(lockedValuesToApply);

    if (!lockedValuesToApply) {
      portalClearAllInicioAnioHiddenAndDisplay();
    } else {
      PORTAL_ANIO_INICIO_IDS.forEach(function (id) {
        const el = document.getElementById(id);
        if (el) portalSyncAnioDisplay(el);
      });
    }
    [
      fechaAnioSelectFin,
      fechaPermisoAnioSelectFin,
      fechaJustificarAnioSelectFin,
      fechaPermisoSinGoceAnioSelectFin
    ].forEach(function (el) {
      if (!el) return;
      portalSyncAnioDisplay(el);
    });
    portalRefreshAllPortalDiaOptions();
    applyPortalLockedDiaFieldValuesOnly(lockedValuesToApply);
    PORTAL_ANIO_INICIO_IDS.forEach(function (id) {
      const el = document.getElementById(id);
      if (el) portalSyncAnioDisplay(el);
    });

    function applyFechasPlaceholderClass(sel) {
      if (sel) sel.classList.toggle("fecha-select-placeholder", sel.value === "");
    }

    function setupFechaSelect(sel) {
      if (!sel) return;
      sel.addEventListener("change", function () {
        applyFechasPlaceholderClass(this);
      });
      applyFechasPlaceholderClass(sel);
    }

    setupFechaSelect(fechaDiaSelect);
    setupFechaSelect(fechaDiaSelectFin);
    setupFechaSelect(fechaPermisoDiaSelect);
    setupFechaSelect(fechaPermisoDiaSelectFin);
    setupFechaSelect(fechaJustificarDiaSelect);
    setupFechaSelect(fechaJustificarDiaSelectFin);
    setupFechaSelect(fechaPermisoSinGoceDiaSelect);
    setupFechaSelect(fechaPermisoSinGoceDiaSelectFin);

    function setupMesSelect(sel) {
      if (!sel) return;
      // Preparar opciones de mes: texto completo y abreviatura
      const mesOptions = Array.from(sel.options).slice(1); // omitir placeholder "Mes"
      mesOptions.forEach((opt) => {
        const full = opt.textContent.trim();
        const abbr = full.slice(0, 3);
        opt.dataset.full = full;
        opt.dataset.abbr = abbr;
      });

      const setMesOptionsToFull = () => {
        mesOptions.forEach((opt) => {
          if (opt.dataset.full) opt.textContent = opt.dataset.full;
        });
      };

      const setMesOptionsToAbbr = () => {
        mesOptions.forEach((opt) => {
          if (opt.dataset.abbr) opt.textContent = opt.dataset.abbr;
        });
      };

      // Mostrar nombres completos al abrir el selector
      sel.addEventListener("mousedown", function () {
        setMesOptionsToFull();
      });

      // Al cambiar, volver a abreviaturas y aplicar estilo de placeholder
      sel.addEventListener("change", function () {
        setMesOptionsToAbbr();
        applyFechasPlaceholderClass(this);
        portalOnMesSelectChange(this);
      });

      // Asegurar que al salir quede en abreviatura
      sel.addEventListener("blur", function () {
        setMesOptionsToAbbr();
      });

      // Estado inicial: placeholder y, si ya hay mes seleccionado, mostrar abreviatura
      setMesOptionsToAbbr();
      applyFechasPlaceholderClass(sel);
    }

    setupMesSelect(fechaMesSelect);
    setupMesSelect(fechaMesSelectFin);
    setupMesSelect(fechaPermisoMesSelect);
    setupMesSelect(fechaPermisoMesSelectFin);
    setupMesSelect(fechaJustificarMesSelect);
    setupMesSelect(fechaJustificarMesSelectFin);
    setupMesSelect(fechaPermisoSinGoceMesSelect);
    setupMesSelect(fechaPermisoSinGoceMesSelectFin);

    Object.keys(PORTAL_MES_TO_PAIR).forEach(function (mesId) {
      const p = PORTAL_MES_TO_PAIR[mesId];
      if (!p.inicio) return;
      const dEl = document.getElementById(p.dia);
      const mesEl = document.getElementById(mesId);
      if (!dEl || !mesEl) return;
      dEl.addEventListener("change", function () {
        const aEl = document.getElementById(p.anio);
        if (!aEl) return;
        const diaOk = String(dEl.value || "").trim() !== "";
        const mesOk = String(mesEl.value || "").trim() !== "";
        if (diaOk && mesOk) {
          if (!String(aEl.value || "").trim()) {
            aEl.value = String(getPortalCalendarYear());
          }
          portalSyncAnioDisplay(aEl);
          aEl.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          aEl.value = "";
          portalSyncAnioDisplay(aEl);
          aEl.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
    });

    clearPortalFechaFinDerivacionSyncers();
    registerPortalFechaFinDerivacion(
      {
        diaInicio: "fechaDiaSelect",
        mesInicio: "fechaMesSelect",
        anioInicio: "fechaAnioSelect",
        diaFin: "fechaDiaSelectFin",
        mesFin: "fechaMesSelectFin",
        anioFin: "fechaAnioSelectFin"
      },
      getPortalVacacionesDiasSolicitadosParaFechaFin
    );
    registerPortalFechaFinDerivacion(
      {
        diaInicio: "fechaJustificarDiaSelect",
        mesInicio: "fechaJustificarMesSelect",
        anioInicio: "fechaJustificarAnioSelect",
        diaFin: "fechaJustificarDiaSelectFin",
        mesFin: "fechaJustificarMesSelectFin",
        anioFin: "fechaJustificarAnioSelectFin"
      },
      getPortalFaltaJustificadaDiasParaFechaFin
    );
    registerPortalFechaFinDerivacion(
      {
        diaInicio: "fechaPermisoSinGoceDiaSelect",
        mesInicio: "fechaPermisoSinGoceMesSelect",
        anioInicio: "fechaPermisoSinGoceAnioSelect",
        diaFin: "fechaPermisoSinGoceDiaSelectFin",
        mesFin: "fechaPermisoSinGoceMesSelectFin",
        anioFin: "fechaPermisoSinGoceAnioSelectFin"
      },
      getPortalPermisoSinGoceDiasParaFechaFin
    );
    registerPortalFechaFinDerivacion(
      {
        diaInicio: "fechaPermisoDiaSelect",
        mesInicio: "fechaPermisoMesSelect",
        anioInicio: "fechaPermisoAnioSelect",
        diaFin: "fechaPermisoDiaSelectFin",
        mesFin: "fechaPermisoMesSelectFin",
        anioFin: "fechaPermisoAnioSelectFin"
      },
      getPortalPermisoGoceDiasSolicitadosParaFechaFin
    );
    applyFiltersPortalLocalFechaSync();

    // Placeholder gris para "Seleccionar permiso" en Permiso de goce
    const permisoGoceSelect = document.getElementById("permisoGoceSelect");
    if (permisoGoceSelect) {
      const applyPermisoGocePlaceholderClass = () => {
        if (permisoGoceSelect.value === "") {
          permisoGoceSelect.classList.add("permiso-goce-placeholder");
        } else {
          permisoGoceSelect.classList.remove("permiso-goce-placeholder");
        }
      };
      permisoGoceSelect.addEventListener("change", applyPermisoGocePlaceholderClass);
      applyPermisoGocePlaceholderClass();
    }

    if (operatorId) {
      if (searchInput) {
        searchInput.value = operatorId;
        searchInput.readOnly = true;
      }
      if (shiftFilter) shiftFilter.disabled = true;
      applyFilters();
    } else {
      applyFilters();
    }

    refreshPortalPermisoStatusUI(operatorId);
  } else {
    // Rol desconocido: por seguridad, redirigir al login
    window.location.href = "index.html";
  }

  setupEstatusPermisoActionButtons();

  // Fallback: si por cualquier motivo no se ligaron handlers en las ramas anteriores,
  // aseguremos que la foto funcione al menos una vez.
  const operatorPhotoWrapAny = document.getElementById("operatorPhotoWrap");
  const operatorPhotoAny = document.getElementById("operatorPhoto");
  const operatorPhotoInputAny = document.getElementById("operatorPhotoInput");
  if (
    operatorPhotoWrapAny &&
    operatorPhotoAny &&
    operatorPhotoInputAny &&
    operatorPhotoWrapAny.dataset.photoHandlersBound !== "1"
  ) {
    operatorPhotoWrapAny.dataset.photoHandlersBound = "1";
    let lastOperatorPhotoObjectUrl = null;
    let ignoreNextOperatorPhotoInputClick = false;
    let ignoreNextOperatorPhotoWrapClick = false;
    const operatorPhotoPlaceholderAny = operatorPhotoWrapAny.querySelector(
      ".operator-photo-placeholder"
    );

    const clearOperatorPhotoAny = () => {
      if (lastOperatorPhotoObjectUrl) {
        URL.revokeObjectURL(lastOperatorPhotoObjectUrl);
        lastOperatorPhotoObjectUrl = null;
      }
      operatorPhotoAny.style.display = "";
      operatorPhotoAny.src = "";
      operatorPhotoAny.setAttribute("src", "");
      if (operatorPhotoPlaceholderAny)
        operatorPhotoPlaceholderAny.style.display = "flex";
      operatorPhotoInputAny.value = "";
    };

    operatorPhotoWrapAny.addEventListener("click", function () {
      if (ignoreNextOperatorPhotoWrapClick) return;
      const srcAttr = operatorPhotoAny.getAttribute("src") || "";
      const hasPhoto = srcAttr.trim() !== "";
      if (hasPhoto) {
        clearOperatorPhotoAny();
        return;
      }
    });

    operatorPhotoInputAny.addEventListener("click", function (event) {
      if (ignoreNextOperatorPhotoInputClick) {
        ignoreNextOperatorPhotoInputClick = false;
        return;
      }
      const srcAttr = operatorPhotoAny.getAttribute("src") || "";
      const hasPhoto = srcAttr.trim() !== "";
      if (!hasPhoto) return;
      event.preventDefault();
      event.stopPropagation();
      clearOperatorPhotoAny();
    });

    operatorPhotoInputAny.addEventListener("change", function () {
      ignoreNextOperatorPhotoInputClick = true;
      ignoreNextOperatorPhotoWrapClick = true;
      setTimeout(() => {
        ignoreNextOperatorPhotoInputClick = false;
        ignoreNextOperatorPhotoWrapClick = false;
      }, 300);

      const file =
        operatorPhotoInputAny.files && operatorPhotoInputAny.files[0];
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        alert("Por favor selecciona una imagen (.png, .jpg, etc.).");
        operatorPhotoInputAny.value = "";
        return;
      }

      const url = URL.createObjectURL(file);
      lastOperatorPhotoObjectUrl = url;

      operatorPhotoAny.setAttribute("src", url);
      operatorPhotoAny.src = url;
      operatorPhotoAny.style.display = "block";
      if (operatorPhotoPlaceholderAny)
        operatorPhotoPlaceholderAny.style.display = "none";
    });
  }
}

/**
 * maestroop.html — Reset: solicitud en curso con estatus final aún pendiente (no aprobado/rechazado
 * por los 3 admins) → historial con estadoHistorial "na" (pill «Archivada») antes de vaciar el borrador.
 * Si la última fila del historial era de otro ciclo cerrado pero el borrador actual es distinto, se añade fila nueva.
 * Si la solicitud ya constaba como aprobada/rechazada en el historial, no se sustituye por Archivada.
 * @returns {boolean} true si se registró o actualizó una entrada como Archivada
 */
function archivePendienteSolicitudAsNaForMaestroReset(operatorId) {
  const oid = String(operatorId || "").trim();
  if (!oid) return false;

  migrateGlobalSavedPayloadToOperatorIfNeeded(oid);
  migrateGlobalAdminRequestHistoryToOperatorIfNeeded(oid);

  const historyPre = getAdminRequestHistory(oid);
  if (historyPre.length) {
    const liPre = latestHistoryEntryIndex(historyPre);
    const latestPre = historyPre[liPre];
    const normPre = normalizeHistorialEstadoStored(
      latestPre && latestPre.estadoHistorial
    );
    if (normPre === "aprobado" || normPre === "rechazado") {
      return false;
    }
  }

  const s = withComputedEstatusFinal(getPermisoStatus(oid));
  const finalV = normalizePermisoRowValue(s.estatusFinal);
  if (finalV === "aprobado" || finalV === "rechazado") return false;

  /** Sin borrador en localStorage: marcar la última fila del historial como Archivada (na). */
  if (!operatorHasValidSavedRequestInStorage(oid)) {
    let history = getAdminRequestHistory(oid);
    if (!history.length) return false;
    const latestIdx = latestHistoryEntryIndex(history);
    const latest = history[latestIdx];
    const prevNorm = normalizeHistorialEstadoStored(
      latest && latest.estadoHistorial
    );
    if (prevNorm === "aprobado" || prevNorm === "rechazado") return false;
    history = history.map((entry, idx) =>
      idx === latestIdx
        ? {
            ...entry,
            estadoHistorial: "na",
            maestroResetArchivada: true,
          }
        : entry
    );
    setAdminRequestHistory(oid, history);
    syncAdminRequestHistoryEstados(oid);
    syncOperatorLatestSolicitudFirestoreStatus(oid, "archivada");
    return true;
  }

  const payload = getLastSavedPayloadFromOperator(oid);
  if (!payload) return false;

  const payloadStr = JSON.stringify(payload);
  let history = getAdminRequestHistory(oid);

  if (!history.length) {
    setAdminRequestHistory(oid, [
      {
        ts: Date.now(),
        tipo: "Solicitud",
        payload,
        estadoHistorial: "na",
        maestroResetArchivada: true,
      },
    ]);
    syncAdminRequestHistoryEstados(oid);
    syncOperatorLatestSolicitudFirestoreStatus(oid, "archivada");
    return true;
  }

  const latestIdx = latestHistoryEntryIndex(history);
  const latest = history[latestIdx];
  const latestPayloadStr =
    latest && latest.payload ? JSON.stringify(latest.payload) : "";

  if (latestPayloadStr === payloadStr) {
    const verdictLatest = normalizeHistorialEstadoStored(
      latest && latest.estadoHistorial
    );
    if (verdictLatest === "aprobado" || verdictLatest === "rechazado") {
      return false;
    }
    history = history.map((entry, idx) =>
      idx === latestIdx
        ? {
            ...entry,
            estadoHistorial: "na",
            maestroResetArchivada: true,
          }
        : entry
    );
    setAdminRequestHistory(oid, history);
    syncAdminRequestHistoryEstados(oid);
    syncOperatorLatestSolicitudFirestoreStatus(oid, "archivada");
    return true;
  }

  history.push({
    ts: Date.now(),
    tipo: "Solicitud",
    payload,
    estadoHistorial: "na",
    maestroResetArchivada: true,
  });
  history = history.slice(-25);
  setAdminRequestHistory(oid, history);
  syncAdminRequestHistoryEstados(oid);
  syncOperatorLatestSolicitudFirestoreStatus(oid, "archivada");
  return true;
}

/**
 * Después de vaciar permiso y borrador: si el ciclo estaba abierto (no unánime),
 * asegura que la última fila del historial quede «Archivada» aunque archive/sync
 * no hubieran dejado estadoHistorial "na" persistido.
 */
function finalizeMaestroResetHistory(operatorId) {
  const oid = String(operatorId || "").trim();
  if (!oid) return false;
  let history = getAdminRequestHistory(oid);
  if (!history.length) return false;
  const latestIdx = latestHistoryEntryIndex(history);
  const latest = history[latestIdx];
  const n = normalizeHistorialEstadoStored(latest && latest.estadoHistorial);
  if (n === "aprobado" || n === "rechazado") return false;
  if (n === "na" && isMaestroArchivadaMarker(latest)) return false;
  history = history.map((entry, idx) =>
    idx === latestIdx
      ? { ...entry, estadoHistorial: "na", maestroResetArchivada: true }
      : entry
  );
  setAdminRequestHistory(oid, history);
  syncAdminRequestHistoryEstados(oid);
  syncOperatorLatestSolicitudFirestoreStatus(oid, "archivada");
  return true;
}

function setupMaestroOp() {
  const isAuth = window.sessionStorage.getItem("vacaciones_auth");
  const role = window.sessionStorage.getItem("vacaciones_role");
  if (isAuth !== "true" || role !== "maestroop") {
    window.location.href = "index.html";
    return;
  }

  const searchInput = document.getElementById("maestroSearchInput");
  const searchBtn = document.getElementById("maestroSearchBtn");
  const card = document.getElementById("maestroOperatorCard");
  const dataWrap = document.getElementById("maestroOperatorData");
  const resetBtn = document.getElementById("maestroResetBtn");
  const clearHistoryBtn = document.getElementById("maestroClearHistoryBtn");
  const resetDiasDisponiblesBtn = document.getElementById(
    "maestroResetDiasDisponiblesBtn"
  );
  const statusEl = document.getElementById("maestroResetStatus");
  if (
    !searchInput ||
    !searchBtn ||
    !card ||
    !dataWrap ||
    !resetBtn ||
    !clearHistoryBtn ||
    !statusEl
  ) {
    return;
  }

  const operators = generateOperators(500);
  let selectedOperator = null;

  function renderOperator(op) {
    dataWrap.innerHTML = `
      <table class="operator-detail-table" aria-label="Datos del operador seleccionado">
        <tbody>
          <tr><td class="operator-detail-label">ID</td><td>${escapeHtml(op.id)}</td></tr>
          <tr><td class="operator-detail-label">Nombre</td><td>${escapeHtml(op.nombreCompleto)}</td></tr>
          <tr><td class="operator-detail-label">Puesto</td><td>${escapeHtml(op.puesto)}</td></tr>
          <tr><td class="operator-detail-label">Turno</td><td>${escapeHtml(op.turno)}</td></tr>
          <tr><td class="operator-detail-label">Fech. Ingr.</td><td>${escapeHtml(op.fechaIngreso)}</td></tr>
        </tbody>
      </table>
    `;
    renderMaestroVacationSaldoDebugInfo(op && op.id ? String(op.id).trim() : "");
  }

  function resetSavedRequestByOperatorId(operatorId) {
    if (operatorId == null || operatorId === "") return false;
    operatorId = String(operatorId).trim();

    migrateGlobalSavedPayloadToOperatorIfNeeded(operatorId);
    migrateGlobalAdminRequestHistoryToOperatorIfNeeded(operatorId);
    const sPre = withComputedEstatusFinal(getPermisoStatus(operatorId));
    const finalPre = normalizePermisoRowValue(sPre.estatusFinal);
    const wasOpenCycle =
      finalPre !== "aprobado" && finalPre !== "rechazado";

    // Pendiente en curso → historial «Archivada» (na); ya cerrada por los 3 admins →
    // resetPortalOperatorForNewSolicitud fija aprobado/rechazado como «Generar nueva solicitud».
    const archivada = archivePendienteSolicitudAsNaForMaestroReset(operatorId);
    resetPortalOperatorForNewSolicitud(operatorId);
    let finalized = false;
    if (wasOpenCycle) {
      finalized = finalizeMaestroResetHistory(operatorId);
    }
    try {
      broadcastPermisoStatusChanged(operatorId);
    } catch (e) {
      /* ignore */
    }
    return archivada || finalized;
  }

  function doSearch() {
    const q = searchInput.value.trim().toLowerCase();
    statusEl.textContent = "";
    if (!q) {
      selectedOperator = null;
      card.style.display = "none";
      dataWrap.innerHTML = "";
      const debugBox = document.getElementById("maestroVacationSaldoDebugBox");
      if (debugBox && debugBox.parentNode) debugBox.parentNode.removeChild(debugBox);
      return;
    }

    let op = null;
    if (/^[0-9]+$/.test(q)) {
      op = operators.find((o) => o.id === q) || null;
    }
    if (!op) {
      op =
        operators.find((o) => o.nombreCompleto.toLowerCase() === q) || null;
    }
    if (!op) {
      op =
        operators.find((o) =>
          o.nombreCompleto.toLowerCase().includes(q)
        ) || null;
    }

    if (!op) {
      selectedOperator = null;
      card.style.display = "none";
      dataWrap.innerHTML = "";
      statusEl.textContent = "No se encontró operador con ese nombre o ID.";
      const debugBox = document.getElementById("maestroVacationSaldoDebugBox");
      if (debugBox && debugBox.parentNode) debugBox.parentNode.removeChild(debugBox);
      return;
    }

    selectedOperator = op;
    renderOperator(op);
    card.style.display = "block";
  }

  searchBtn.addEventListener("click", doSearch);
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") doSearch();
  });

  resetBtn.addEventListener("click", () => {
    if (!selectedOperator) {
      statusEl.textContent = "Selecciona un operador primero.";
      return;
    }
    const id = String(selectedOperator.id).trim();
    const archivada = resetSavedRequestByOperatorId(id);
    statusEl.textContent = archivada
      ? `Operador ${id}: solicitud pendiente en curso archivada en el historial (Archivada). Borrador reiniciado.`
      : `Operador ${id}: reiniciado. (Sin borrador pendiente que archivar, o solicitud ya cerrada por admins.)`;
    renderMaestroVacationSaldoDebugInfo(id);
  });

  clearHistoryBtn.addEventListener("click", () => {
    if (!selectedOperator) {
      statusEl.textContent = "Selecciona un operador primero.";
      return;
    }
    const opId = String(selectedOperator.id).trim();
    window.localStorage.removeItem(adminRequestHistoryStorageKey(opId));
    statusEl.textContent =
      `Historial local de ${opId} borrado. Eliminando en Firestore...`;
    deleteSolicitudesFromFirestoreByOperator(opId)
      .then(function (res) {
        const deletedCount =
          res && Number.isFinite(res.deletedCount) ? res.deletedCount : 0;
        if (res && res.skipped) {
          statusEl.textContent =
            `Historial local de ${opId} borrado. Firestore no disponible en esta sesion.`;
          return;
        }
        return syncVacationSaldoFromLocalToFirestore(opId).then(function () {
          const restante = getPortalVacationSaldoRestante(opId);
          statusEl.textContent =
            `Historial de solicitudes de ${opId} borrado (Firestore: ${deletedCount} docs). ` +
            `Saldo de días no se reinicia: quedan ${restante} días disponibles (consumo guardado aparte en operatorVacationSaldo).`;
          return renderMaestroVacationSaldoDebugInfo(opId);
        });
      })
      .catch(function (err) {
        console.warn("[Firestore] borrar historial por operador:", err);
        statusEl.textContent =
          `Historial local de ${opId} borrado. No se pudo borrar Firestore (revisa reglas/permisos).`;
      });
  });

  if (resetDiasDisponiblesBtn) {
    resetDiasDisponiblesBtn.addEventListener("click", () => {
      if (!selectedOperator) {
        statusEl.textContent = "Selecciona un operador primero.";
        return;
      }
      const opId = String(selectedOperator.id).trim();
      statusEl.textContent = `Operador ${opId}: aplicando restablecimiento…`;
      clearVacationDaysConsumedStorageForOperator(opId).then(function () {
        statusEl.textContent =
          `Operador ${opId}: días disponibles de vacaciones = ${DIAS_VACACIONALES_BASE} ` +
          "(consumo en 0; guardado en este navegador y en Firestore). " +
          "Abre portal y maestroop con la misma URL (http://…); con file:// cada página tiene su propio almacenamiento.";
        renderMaestroVacationSaldoDebugInfo(opId);
      });
    });
  }
}

function setupLogin() {
  const userInput = document.getElementById("loginUser");
  const passInput = document.getElementById("loginPass");
  const loginButton = document.getElementById("loginButton");
  const errorEl = document.getElementById("loginError");

  // Cada vez que se entra a la pantalla de login, se invalida la sesión
  window.sessionStorage.removeItem("vacaciones_auth");
  window.sessionStorage.removeItem("vacaciones_role");
  window.sessionStorage.removeItem("vacaciones_operator_id");
  window.sessionStorage.removeItem("vacaciones_admin_profile");
  window.sessionStorage.removeItem("vacaciones_admin_username");

  if (!userInput || !passInput || !loginButton) {
    console.error("No se pudieron inicializar los controles de login.");
    return;
  }

  const doLogin = async () => {
    const username = userInput.value.trim();
    const password = passInput.value;

    let role = null;
    let operatorId = null;
    let redirectTo = null;

    // Acceso exclusivo a maestroop.html
    if (username === "Samsong1234" && password === "SAMSONG_HARV_2026") {
      role = "maestroop";
      redirectTo = "maestroop.html";
    }

    // Maestro: usuario principal
    else if (username === MASTER_USER && password === MASTER_PASSWORD) {
      role = "maestro";
    } else if (
      ADMIN_CREDENTIALS.some(
        (a) => a.user === username && a.password === password
      )
    ) {
      role = "admin";
    } else {
      // Usuario local: usuario = ID (1001–1500), contraseña = SAMSONG_LOCAL_<ID>
      const isNumericId = /^[0-9]+$/.test(username);
      const numericId = Number(username);
      const expectedLocalPassword = "SAMSONG_LOCAL_" + username;
      if (
        isNumericId &&
        numericId >= 1001 &&
        numericId <= 1500 &&
        password === expectedLocalPassword
      ) {
        role = "local";
        operatorId = username;
      }
    }

    if (role) {
      if (errorEl) errorEl.textContent = "";
      window.sessionStorage.setItem("vacaciones_auth", "true");
      window.sessionStorage.setItem("vacaciones_role", role);
      window.sessionStorage.removeItem("vacaciones_admin_profile");
      if (role === "admin" || role === "maestro") {
        window.sessionStorage.setItem("vacaciones_admin_username", username);
      } else {
        window.sessionStorage.removeItem("vacaciones_admin_username");
      }
      if (role === "admin" && ADMIN_PROFILE_BY_USER[username]) {
        window.sessionStorage.setItem(
          "vacaciones_admin_profile",
          ADMIN_PROFILE_BY_USER[username]
        );
      }
      if (operatorId) {
        window.sessionStorage.setItem("vacaciones_operator_id", operatorId);
      } else {
        window.sessionStorage.removeItem("vacaciones_operator_id");
      }
      // Redirección por rol:
      // - local => portal.html
      // - admin/maestro => admin.html
      // - maestroop => maestroop.html
      if (role === "local" && operatorId) {
        // Antes de abrir portal, restaurar consumo desde Firestore para evitar volver a base tras borrar cookies.
        await hydrateVacationConsumedFromFirestoreForLogin(operatorId);
      }

      if (redirectTo) {
        window.location.href = redirectTo;
      } else {
        window.location.href = role === "local" ? "portal.html" : "admin.html";
      }
    } else if (errorEl) {
      errorEl.textContent = "Usuario o contraseña incorrectos.";
    }
  };

  loginButton.addEventListener("click", doLogin);
  passInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      doLogin();
    }
  });
  userInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      doLogin();
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const appRoot = document.getElementById("appRoot");
  const maestroOpRoot = document.getElementById("maestroOpRoot");

  if (appRoot) {
    // Estamos en portal.html: sólo permitimos acceso si hay sesión activa
    const isAuth = window.sessionStorage.getItem("vacaciones_auth");
    if (isAuth !== "true") {
      window.location.href = "index.html";
      return;
    }

    // Fuera de index.html no debe mostrarse la imagen de fondo del login.
    document.documentElement.style.backgroundImage = "none";
    document.documentElement.style.backgroundColor = "#ffffff";
    document.body.style.backgroundImage = "none";
    document.body.style.backgroundColor = "#ffffff";
    appRoot.classList.remove("hidden");
    try {
      init();
    } finally {
      // portal.html / admin.html: quitar capa de arranque tras init() y un frame de layout estable.
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          var ov =
            document.getElementById("appBootOverlay") ||
            document.getElementById("portalBootOverlay");
          if (ov) ov.remove();
        });
      });
    }
  } else if (maestroOpRoot) {
    // maestroop.html también sin imagen de fondo (solo index la conserva).
    document.documentElement.style.backgroundImage = "none";
    document.documentElement.style.backgroundColor = "#ffffff";
    document.body.style.backgroundImage = "none";
    document.body.style.backgroundColor = "#ffffff";
    try {
      setupMaestroOp();
    } finally {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          var ov =
            document.getElementById("appBootOverlay") ||
            document.getElementById("portalBootOverlay");
          if (ov) ov.remove();
        });
      });
    }
  } else {
    // Estamos en index.html (pantalla de login)
    setupLogin();
  }
});

