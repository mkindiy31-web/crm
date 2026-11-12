const express = require('express');

// Express 4 не бачить відмови async-обробника: помилка бази в будь-якому
// маршруті лишалась «unhandled rejection», і Node зупиняв увесь процес, а з ним
// СРМ для всіх менеджерів. Тут кожен обробник маршрутизатора загортається так,
// що відмова йде в next(err), до загального обробника помилок у index.js.
//
// Підключається ПЕРШИМ, до require будь-якого файлу маршрутів: ті беруть
// express.Router у момент завантаження.
const METHODS = ['all', 'get', 'post', 'put', 'patch', 'delete', 'use'];

function wrap(fn) {
  // Обробник помилок (4 аргументи) і не-функції лишаються як є.
  if (typeof fn !== 'function' || fn.length >= 4) return fn;
  const wrapped = function (req, res, next) {
    const out = fn.call(this, req, res, next);
    if (out && typeof out.catch === 'function') out.catch(next);
    return out;
  };
  // Вкладений маршрутизатор має лишатись маршрутизатором: Express кличе його
  // як функцію, а його властивості (stack, params) потрібні лише йому самому.
  return Object.assign(wrapped, fn);
}

const originalRouter = express.Router;
express.Router = function patchedRouter(...args) {
  const router = originalRouter.apply(this, args);
  for (const m of METHODS) {
    const orig = router[m];
    router[m] = function (...handlers) { return orig.apply(this, handlers.map(wrap)); };
  }
  return router;
};

// Останній у ланцюжку: відповідь замість падіння процесу.
function errorHandler(err, req, res, next) {
  console.error(`${req.method} ${req.originalUrl} failed:`, err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Помилка сервера, спробуйте ще раз' });
}

module.exports = { errorHandler, wrap };
