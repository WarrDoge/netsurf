/* Polyfiller for Duktape for NetSurf
 *
 * This JavaScript will be loaded into heaps before the generics
 *
 * We only care for the side-effects of this, be careful.
 */

// Production steps of ECMA-262, Edition 6, 22.1.2.1
if (!Array.from) {
  Array.from = (function () {
    var toStr = Object.prototype.toString;
    var isCallable = function (fn) {
      return typeof fn === 'function' || toStr.call(fn) === '[object Function]';
    };
    var toInteger = function (value) {
      var number = Number(value);
      if (isNaN(number)) { return 0; }
      if (number === 0 || !isFinite(number)) { return number; }
      return (number > 0 ? 1 : -1) * Math.floor(Math.abs(number));
    };
    var maxSafeInteger = Math.pow(2, 53) - 1;
    var toLength = function (value) {
      var len = toInteger(value);
      return Math.min(Math.max(len, 0), maxSafeInteger);
    };

    // The length property of the from method is 1.
    return function from(arrayLike/*, mapFn, thisArg */) {
      // 1. Let C be the this value.
      var C = this;

      // 2. Let items be ToObject(arrayLike).
      var items = Object(arrayLike);

      // 3. ReturnIfAbrupt(items).
      if (arrayLike == null) {
        throw new TypeError('Array.from requires an array-like object - not null or undefined');
      }

      // 4. If mapfn is undefined, then let mapping be false.
      var mapFn = arguments.length > 1 ? arguments[1] : void undefined;
      var T;
      if (typeof mapFn !== 'undefined') {
        // 5. else
        // 5. a If IsCallable(mapfn) is false, throw a TypeError exception.
        if (!isCallable(mapFn)) {
          throw new TypeError('Array.from: when provided, the second argument must be a function');
        }

        // 5. b. If thisArg was supplied, let T be thisArg; else let T be undefined.
        if (arguments.length > 2) {
          T = arguments[2];
        }
      }

      // 10. Let lenValue be Get(items, "length").
      // 11. Let len be ToLength(lenValue).
      var len = toLength(items.length);

      // 13. If IsConstructor(C) is true, then
      // 13. a. Let A be the result of calling the [[Construct]] internal method 
      // of C with an argument list containing the single item len.
      // 14. a. Else, Let A be ArrayCreate(len).
      var A = isCallable(C) ? Object(new C(len)) : new Array(len);

      // 16. Let k be 0.
      var k = 0;
      // 17. Repeat, while k < len… (also steps a - h)
      var kValue;
      while (k < len) {
        kValue = items[k];
        if (mapFn) {
          A[k] = typeof T === 'undefined' ? mapFn(kValue, k) : mapFn.call(T, kValue, k);
        } else {
          A[k] = kValue;
        }
        k += 1;
      }
      // 18. Let putStatus be Put(A, "length", len, true).
      A.length = len;
      // 20. Return A.
      return A;
    };
  }());
}

// DOMTokenList formatter, in theory we can remove this if we do the stringifier IDL support

DOMTokenList.prototype.toString = function () {
  if (this.length == 0) {
    return "";
  }

  var ret = this.item(0);
  for (var index = 1; index < this.length; index++) {
    ret = ret + " " + this.item(index);
  }

  return ret;
}

// Inherit the same toString for settable lists
DOMSettableTokenList.prototype.toString = DOMTokenList.prototype.toString;

/* Promise, and the microtask queue it runs on.
 *
 * Duktape 2.7 is ES5.1 with pieces of ES2015 and has no Promise. Nothing
 * needs promises to be fast, but a great deal of modern code needs them to
 * exist, so a polyfill is the right trade here.
 *
 * Reactions are queued rather than run inline, as the specification
 * requires. The host drains the queue after each script and each event
 * through NetSurfDrainMicrotasks, which dukky moves off the global object
 * once this file has run.
 */
var NetSurfPromiseSupport = (function () {
  var queue = [];
  var draining = false;

  function enqueue(job) {
    queue.push(job);
  }

  function drain() {
    if (draining) {
      return;
    }
    draining = true;
    try {
      /* a job may queue further jobs, which must run in the same drain */
      while (queue.length > 0) {
        var job = queue.shift();
        job();
      }
    } finally {
      draining = false;
    }
  }

  var PENDING = 0, FULFILLED = 1, REJECTED = 2;

  function isThenable(x) {
    return x !== null &&
        (typeof x === 'object' || typeof x === 'function') &&
        typeof x.then === 'function';
  }

  function settle(promise, state, value) {
    if (promise._state !== PENDING) {
      return;
    }

    promise._state = state;
    promise._value = value;

    var reactions = promise._reactions;
    promise._reactions = [];

    for (var i = 0; i < reactions.length; i++) {
      enqueue(reactions[i]);
    }
  }

  function resolve(promise, value) {
    if (promise._state !== PENDING) {
      return;
    }

    if (value === promise) {
      settle(promise, REJECTED,
             new TypeError('Chaining cycle detected for promise'));
      return;
    }

    if (isThenable(value)) {
      var called = false;
      try {
        value.then(function (v) {
          if (!called) { called = true; resolve(promise, v); }
        }, function (e) {
          if (!called) { called = true; settle(promise, REJECTED, e); }
        });
      } catch (e) {
        if (!called) { called = true; settle(promise, REJECTED, e); }
      }
      return;
    }

    settle(promise, FULFILLED, value);
  }

  function react(promise, onFulfilled, onRejected, next) {
    return function () {
      var handler = promise._state === FULFILLED ? onFulfilled : onRejected;

      if (typeof handler !== 'function') {
        /* pass the settled value straight through the chain */
        if (promise._state === FULFILLED) {
          resolve(next, promise._value);
        } else {
          settle(next, REJECTED, promise._value);
        }
        return;
      }

      try {
        resolve(next, handler(promise._value));
      } catch (e) {
        settle(next, REJECTED, e);
      }
    };
  }

  function Promise(executor) {
    if (!(this instanceof Promise)) {
      throw new TypeError("Constructor Promise requires 'new'");
    }
    if (typeof executor !== 'function') {
      throw new TypeError('Promise resolver is not a function');
    }

    this._state = PENDING;
    this._value = undefined;
    this._reactions = [];

    var self = this;
    try {
      executor(function (v) { resolve(self, v); },
               function (e) { settle(self, REJECTED, e); });
    } catch (e) {
      settle(self, REJECTED, e);
    }
  }

  Promise.prototype.then = function (onFulfilled, onRejected) {
    var next = new Promise(function () {});
    var job = react(this, onFulfilled, onRejected, next);

    if (this._state === PENDING) {
      this._reactions.push(job);
    } else {
      enqueue(job);
    }

    return next;
  };

  Promise.prototype['catch'] = function (onRejected) {
    return this.then(undefined, onRejected);
  };

  Promise.prototype['finally'] = function (onFinally) {
    return this.then(function (v) {
      if (typeof onFinally === 'function') { onFinally(); }
      return v;
    }, function (e) {
      if (typeof onFinally === 'function') { onFinally(); }
      throw e;
    });
  };

  Promise.resolve = function (value) {
    if (value instanceof Promise) {
      return value;
    }
    return new Promise(function (res) { res(value); });
  };

  Promise.reject = function (reason) {
    return new Promise(function (res, rej) { rej(reason); });
  };

  Promise.all = function (items) {
    return new Promise(function (res, rej) {
      var values = [];
      var remaining = 0;
      var done = false;

      function one(index, item) {
        remaining++;
        Promise.resolve(item).then(function (v) {
          values[index] = v;
          if (--remaining === 0 && done) { res(values); }
        }, rej);
      }

      for (var i = 0; i < items.length; i++) {
        one(i, items[i]);
      }

      done = true;
      if (remaining === 0) { res(values); }
    });
  };

  Promise.race = function (items) {
    return new Promise(function (res, rej) {
      for (var i = 0; i < items.length; i++) {
        Promise.resolve(items[i]).then(res, rej);
      }
    });
  };

  Promise.allSettled = function (items) {
    return Promise.all(Array.prototype.map.call(items, function (item) {
      return Promise.resolve(item).then(function (value) {
        return { status: 'fulfilled', value: value };
      }, function (reason) {
        return { status: 'rejected', reason: reason };
      });
    }));
  };

  return { promise: Promise, drain: drain };
})();

/* Hand the exports back as this program's completion value. Neither a var
 * binding nor a bare assignment made here reaches the object that page
 * scripts resolve names against, because the file is evaluated as an eval
 * program against the global the Window replaced, so dukky installs them
 * from C instead.
 */
NetSurfPromiseSupport;
