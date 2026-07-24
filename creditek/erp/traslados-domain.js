(function (global) {
  'use strict';

  function puedeRecibir(perfil, traslado) {
    return perfil?.rol === 'admin_tienda' &&
      traslado?.estado === 'despachado' &&
      perfil?.tienda_codigo === traslado?.tienda_destino;
  }

  global.CreditekTrasladosDomain = Object.freeze({ puedeRecibir });
})(typeof window !== 'undefined' ? window : globalThis);
