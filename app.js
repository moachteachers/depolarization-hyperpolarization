(function () {
  "use strict";

  var membraneCanvas = document.getElementById("membrane-canvas");
  var graphCanvas = document.getElementById("voltage-graph");
  var membraneContext = membraneCanvas.getContext("2d");
  var graphContext = graphCanvas.getContext("2d");
  var toggleCurrentButton = document.getElementById("toggle-current");
  var currentButtonLabel = toggleCurrentButton.querySelector(".current-label");
  var currentButtonIcon = toggleCurrentButton.querySelector(".current-icon");
  var resetButton = document.getElementById("reset-simulation");
  var stageIndicator = document.getElementById("stage-indicator");
  var stageLabel = document.getElementById("stage-label");
  var stageContinueButton = document.getElementById("stage-continue");
  var voltageOutput = document.getElementById("graph-voltage");
  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  var VOLTAGE_STEP = 14;
  var MAX_SURFACE_PAIRS = 7;
  var FLUX_DURATION = 1.86;
  var FLUX_GAP = 0.42;
  var START_DELAY = 0.27;

  var COLORS = {
    ink: "#17352f",
    muted: "#637a73",
    positive: "#df4747",
    positiveDark: "#8f2020",
    negative: "#2c73c5",
    negativeDark: "#164985",
    membrane: "#7ebe2e",
    membraneDark: "#4e8e16",
    membraneLight: "#a5d85a",
    trace: "#116f9a",
    traceGlow: "rgba(17, 111, 154, 0.16)"
  };

  var state = {
    voltage: -70,
    charge: 1,
    direction: 1,
    isRunning: false,
    stageSession: false,
    stageGate: null,
    elapsed: 0,
    history: [{ t: 0, v: -70 }],
    historyClock: 0,
    particles: [],
    particleSerial: 0,
    flux: null,
    fluxSerial: 0,
    nextFluxAt: Infinity,
    transitions: [],
    resetEpoch: 0,
    layout: null,
    graphSize: { width: 0, height: 0 },
    lastTime: performance.now(),
    lastSurface: [],
    lastFluxSnapshot: null,
    ariaClock: 0
  };

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function smooth(t) {
    var x = clamp(t, 0, 1);
    return x * x * (3 - 2 * x);
  }

  function pointLerp(a, b, t) {
    var eased = smooth(t);
    return {
      x: lerp(a.x, b.x, eased),
      y: lerp(a.y, b.y, eased)
    };
  }

  function signOf(value) {
    return value < 0 ? -1 : value > 0 ? 1 : 0;
  }

  function effectSign(charge, direction) {
    return Number(charge) * Number(direction);
  }

  function isGuidedDepolarization(charge, direction) {
    return effectSign(charge, direction) === 1;
  }

  function stageNumberForVoltage(voltage) {
    if (voltage < 0) {
      return 1;
    }
    if (voltage === 0) {
      return 2;
    }
    return 3;
  }

  function surfacePairs(voltage) {
    if (Math.abs(voltage) < VOLTAGE_STEP / 2) {
      return 0;
    }
    return Math.min(MAX_SURFACE_PAIRS, Math.round(Math.abs(voltage) / VOLTAGE_STEP));
  }

  function eventTransition(voltage, charge, direction) {
    var beforeK = Math.round(Number(voltage) / VOLTAGE_STEP);
    var effect = effectSign(charge, direction);
    var afterK = clamp(beforeK + effect, -MAX_SURFACE_PAIRS, MAX_SURFACE_PAIRS);
    var mode = beforeK !== 0 && beforeK * effect < 0 ? "neutralize" : "separate";
    return {
      effect: effect,
      mode: mode,
      blocked: afterK === beforeK,
      beforeVoltage: beforeK * VOLTAGE_STEP,
      afterVoltage: afterK * VOLTAGE_STEP,
      beforePairs: Math.abs(beforeK),
      afterPairs: Math.abs(afterK),
      beforeOutsideSign: beforeK === 0 ? 0 : -signOf(beforeK),
      beforeInsideSign: signOf(beforeK),
      afterOutsideSign: afterK === 0 ? 0 : -signOf(afterK),
      afterInsideSign: signOf(afterK)
    };
  }

  function formatVoltage(value) {
    var rounded = Math.abs(value) < 0.05 ? 0 : value;
    var prefix = rounded > 0 ? "+" : rounded < 0 ? "−" : "";
    return prefix + Math.abs(rounded).toFixed(1) + " mV";
  }

  function seededRandom(seed) {
    var value = seed >>> 0;
    return function () {
      value += 0x6d2b79f5;
      var t = value;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function roundedRect(context, x, y, width, height, radius) {
    var r = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + r, y);
    context.arcTo(x + width, y, x + width, y + height, r);
    context.arcTo(x + width, y + height, x, y + height, r);
    context.arcTo(x, y + height, x, y, r);
    context.arcTo(x, y, x + width, y, r);
    context.closePath();
  }

  function rectsIntersect(a, b) {
    return !(
      a.x + a.width <= b.x ||
      b.x + b.width <= a.x ||
      a.y + a.height <= b.y ||
      b.y + b.height <= a.y
    );
  }

  function pointInsideExpandedRect(x, y, rect, padding) {
    return (
      x > rect.x - padding &&
      x < rect.x + rect.width + padding &&
      y > rect.y - padding &&
      y < rect.y + rect.height + padding
    );
  }

  function resizeCanvas(canvas, context) {
    var rect = canvas.getBoundingClientRect();
    var width = Math.max(1, Math.round(rect.width));
    var height = Math.max(1, Math.round(rect.height));
    var ratio = Math.min(window.devicePixelRatio || 1, 2);
    var pixelWidth = Math.round(width * ratio);
    var pixelHeight = Math.round(height * ratio);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { width: width, height: height, ratio: ratio };
  }

  function buildLayout(width, height) {
    var mobile = width < 520;
    var radius = clamp(width / 92, 10, 14);
    var surfaceRadius = clamp(width / 48, 7, 12);
    var membraneY = Math.round(height * 0.52);
    var membraneHeight = clamp(height * 0.07, 40, 48);
    var channelX = mobile ? width * 0.43 : width * 0.53;
    var channelWidth = radius * 3.15;
    var meterScale = clamp(Math.min(width / 640, height / 560), 0.55, 1);
    var meterWidth = 146 * meterScale;
    var meterHeight = 184 * meterScale;
    var meter = {
      x: width - meterWidth - 22 * meterScale,
      y: 20 * meterScale,
      width: meterWidth,
      height: meterHeight,
      scale: meterScale
    };
    var outsideSurfaceY = membraneY - membraneHeight / 2 - radius - 7;
    var insideSurfaceY = membraneY + membraneHeight / 2 + radius + 7;
    var outsideBounds = {
      xMin: 18 + radius,
      xMax: width - 18 - radius,
      yMin: 18 + radius,
      yMax: outsideSurfaceY - radius - 18
    };
    var insideBounds = {
      xMin: 18 + radius,
      xMax: width - 18 - radius,
      yMin: insideSurfaceY + radius + 18,
      yMax: height - 18 - radius
    };
    var outsideLabel = {
      x: 18,
      y: 18,
      width: mobile ? 105 : 124,
      height: 36
    };
    var stageBadge = {
      x: width / 2 - (mobile ? 64 : 76),
      y: 8,
      width: mobile ? 128 : 152,
      height: 48
    };
    var insideLabel = {
      x: 18,
      y: height - 54,
      width: mobile ? 94 : 108,
      height: 36
    };
    var membraneLabel = {
      x: mobile ? 17 : width * 0.16,
      y: membraneY - 15,
      width: mobile ? 91 : 112,
      height: 30
    };
    var channel = {
      x: channelX - channelWidth / 2,
      y: membraneY - membraneHeight / 2 - 23,
      width: channelWidth,
      height: membraneHeight + 46
    };
    var outsideElectrodeX = meter.x - 26 * meterScale;
    var insideHeadX = meter.x - 34 * meterScale;
    var insideTipX = Math.max(channel.x + channel.width + radius * 3.1, meter.x - 70 * meterScale);
    var outsideElectrode = {
      x: outsideElectrodeX,
      yTop: Math.max(meter.y + meter.height * 0.48, membraneY - 150 * meterScale),
      yTip: membraneY - membraneHeight / 2 - 42 * meterScale
    };
    var insideElectrode = {
      xHead: insideHeadX,
      yHead: membraneY - membraneHeight / 2 - 90 * meterScale,
      xTip: insideTipX,
      yTip: membraneY + membraneHeight / 2 + 96 * meterScale
    };
    var blackJack = {
      x: meter.x + meter.width * 0.34,
      y: meter.y + meter.height - 13 * meterScale
    };
    var redJack = {
      x: meter.x + meter.width * 0.72,
      y: meter.y + meter.height - 13 * meterScale
    };
    var outsideObstacles = [
      outsideLabel,
      stageBadge,
      {
        x: meter.x - 10,
        y: meter.y - 10,
        width: meter.width + 20,
        height: meter.height + 20
      },
      {
        x: channelX - radius * 2.7,
        y: outsideBounds.yMax - 64,
        width: radius * 5.4,
        height: 82
      },
      {
        x: outsideElectrode.x - radius * 1.6,
        y: outsideElectrode.yTop - 10,
        width: radius * 3.2,
        height: outsideElectrode.yTip - outsideElectrode.yTop + 20
      }
    ];
    var insideObstacles = [
      insideLabel,
      {
        x: channelX - radius * 2.7,
        y: insideBounds.yMin - 18,
        width: radius * 5.4,
        height: 90
      },
      {
        x: Math.min(insideElectrode.xHead, insideElectrode.xTip) - radius * 1.8,
        y: insideElectrode.yHead - 10,
        width: Math.abs(insideElectrode.xHead - insideElectrode.xTip) + radius * 3.6,
        height: insideElectrode.yTip - insideElectrode.yHead + 20
      }
    ];

    return {
      width: width,
      height: height,
      mobile: mobile,
      radius: radius,
      surfaceRadius: surfaceRadius,
      membrane: {
        x: 0,
        y: membraneY - membraneHeight / 2,
        width: width,
        height: membraneHeight
      },
      membraneY: membraneY,
      membraneHeight: membraneHeight,
      membraneLabel: membraneLabel,
      channel: channel,
      channelX: channelX,
      channelWidth: channelWidth,
      outsideSurfaceY: outsideSurfaceY,
      insideSurfaceY: insideSurfaceY,
      outside: outsideBounds,
      inside: insideBounds,
      outsideLabel: outsideLabel,
      stageBadge: stageBadge,
      insideLabel: insideLabel,
      meter: meter,
      outsideElectrode: outsideElectrode,
      insideElectrode: insideElectrode,
      blackJack: blackJack,
      redJack: redJack,
      obstacles: {
        outside: outsideObstacles,
        inside: insideObstacles
      }
    };
  }

  function resizeAll() {
    var membraneSize = resizeCanvas(membraneCanvas, membraneContext);
    var graphSize = resizeCanvas(graphCanvas, graphContext);
    var oldLayout = state.layout;
    state.layout = buildLayout(membraneSize.width, membraneSize.height);
    state.graphSize = graphSize;
    if (
      !oldLayout ||
      Math.abs(oldLayout.width - state.layout.width) > 2 ||
      Math.abs(oldLayout.height - state.layout.height) > 2
    ) {
      initializeParticles();
      if (oldLayout) {
        state.flux = null;
        state.lastFluxSnapshot = null;
        state.nextFluxAt = state.isRunning ? state.elapsed + 0.4 : Infinity;
      }
    }
  }

  function zoneBounds(zone) {
    return zone === "outside" ? state.layout.outside : state.layout.inside;
  }

  function zoneObstacles(zone) {
    return state.layout.obstacles[zone];
  }

  function positionIsClear(x, y, radius, zone, particles) {
    var bounds = zoneBounds(zone);
    if (
      x < bounds.xMin ||
      x > bounds.xMax ||
      y < bounds.yMin ||
      y > bounds.yMax
    ) {
      return false;
    }
    var obstacles = zoneObstacles(zone);
    for (var i = 0; i < obstacles.length; i += 1) {
      if (pointInsideExpandedRect(x, y, obstacles[i], radius + 5)) {
        return false;
      }
    }
    for (var j = 0; j < particles.length; j += 1) {
      var other = particles[j];
      if (other.zone !== zone || other.hidden) {
        continue;
      }
      var dx = x - other.x;
      var dy = y - other.y;
      var minimum = radius + other.r + 7;
      if (dx * dx + dy * dy < minimum * minimum) {
        return false;
      }
    }
    return true;
  }

  function fallbackPosition(zone, radius, index, particles) {
    var bounds = zoneBounds(zone);
    var step = radius * 2 + 9;
    var columns = Math.max(1, Math.floor((bounds.xMax - bounds.xMin) / step));
    var rows = Math.max(1, Math.floor((bounds.yMax - bounds.yMin) / step));
    for (var offset = 0; offset < columns * rows; offset += 1) {
      var cell = (index * 5 + offset) % (columns * rows);
      var column = cell % columns;
      var row = Math.floor(cell / columns);
      var x = bounds.xMin + (column + 0.5) * ((bounds.xMax - bounds.xMin) / columns);
      var y = bounds.yMin + (row + 0.5) * ((bounds.yMax - bounds.yMin) / rows);
      if (positionIsClear(x, y, radius, zone, particles)) {
        return { x: x, y: y };
      }
    }
    return {
      x: clamp(bounds.xMin + (index % columns) * step, bounds.xMin, bounds.xMax),
      y: clamp(bounds.yMin + (Math.floor(index / columns) % rows) * step, bounds.yMin, bounds.yMax)
    };
  }

  function initializeParticles() {
    if (!state.layout) {
      return;
    }
    var particles = [];
    var width = state.layout.width;
    var height = state.layout.height;
    var random = seededRandom(93271 + Math.round(width) * 17 + Math.round(height) * 31);
    var countPerZone = clamp(Math.floor(width / 58), 8, 22);
    if (countPerZone % 2 !== 0) {
      countPerZone -= 1;
    }
    var zones = ["outside", "inside"];
    state.particleSerial = 0;

    zones.forEach(function (zone, zoneIndex) {
      var bounds = zoneBounds(zone);
      for (var i = 0; i < countPerZone; i += 1) {
        var radius = state.layout.radius * (0.88 + random() * 0.16);
        var position = null;
        for (var attempt = 0; attempt < 500; attempt += 1) {
          var x = lerp(bounds.xMin, bounds.xMax, random());
          var y = lerp(bounds.yMin, bounds.yMax, random());
          if (positionIsClear(x, y, radius, zone, particles)) {
            position = { x: x, y: y };
            break;
          }
        }
        if (!position) {
          position = fallbackPosition(zone, radius, i, particles);
        }
        var angle = random() * Math.PI * 2;
        var speed =
          (reducedMotion.matches ? 2.4 : 10) +
          random() * (reducedMotion.matches ? 3.2 : 6);
        particles.push({
          id: "bulk-" + state.particleSerial,
          zone: zone,
          sign: (i + zoneIndex) % 2 === 0 ? 1 : -1,
          x: position.x,
          y: position.y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          r: radius,
          phase: random() * Math.PI * 2,
          frequency: 0.42 + random() * 0.34,
          hidden: false,
          reservedBy: null
        });
        state.particleSerial += 1;
      }
    });
    state.particles = particles;
    solveCollisions(4);
  }

  function particleById(id) {
    if (!id) {
      return null;
    }
    for (var i = 0; i < state.particles.length; i += 1) {
      if (state.particles[i].id === id) {
        return state.particles[i];
      }
    }
    return null;
  }

  function selectFreeParticle(zone, sign, target) {
    var selected = null;
    var bestDistance = Infinity;
    for (var i = 0; i < state.particles.length; i += 1) {
      var particle = state.particles[i];
      if (
        particle.zone !== zone ||
        particle.sign !== sign ||
        particle.hidden ||
        particle.reservedBy
      ) {
        continue;
      }
      var dx = particle.x - target.x;
      var dy = particle.y - target.y;
      var distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        selected = particle;
        bestDistance = distance;
      }
    }
    return selected;
  }

  function reserveParticle(particle, fluxId) {
    particle.hidden = true;
    particle.reservedBy = fluxId;
  }

  function restoreReservedParticle(particle, fluxId) {
    if (!particle || particle.reservedBy !== fluxId) {
      return;
    }
    particle.hidden = false;
    particle.reservedBy = null;
  }

  function removeParticleById(id) {
    for (var i = state.particles.length - 1; i >= 0; i -= 1) {
      if (state.particles[i].id === id) {
        state.particles.splice(i, 1);
        return;
      }
    }
  }

  function clearPositionNear(zone, radius, preferredX, preferredY) {
    var bounds = zoneBounds(zone);
    var x = clamp(preferredX, bounds.xMin, bounds.xMax);
    var y = clamp(preferredY, bounds.yMin, bounds.yMax);
    if (positionIsClear(x, y, radius, zone, state.particles)) {
      return { x: x, y: y };
    }
    var step = radius * 1.15 + 7;
    for (var ring = 1; ring <= 10; ring += 1) {
      var samples = 8 + ring * 4;
      for (var sample = 0; sample < samples; sample += 1) {
        var angle = (sample / samples) * Math.PI * 2 + ring * 0.47;
        var candidateX = clamp(x + Math.cos(angle) * step * ring, bounds.xMin, bounds.xMax);
        var candidateY = clamp(y + Math.sin(angle) * step * ring, bounds.yMin, bounds.yMax);
        if (positionIsClear(candidateX, candidateY, radius, zone, state.particles)) {
          return { x: candidateX, y: candidateY };
        }
      }
    }
    return fallbackPosition(zone, radius, state.particleSerial, state.particles);
  }

  function particleVelocity(seed) {
    var random = seededRandom(seed + 7919);
    var angle = random() * Math.PI * 2;
    var speed =
      (reducedMotion.matches ? 2.4 : 10) +
      random() * (reducedMotion.matches ? 3.2 : 6);
    return {
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      phase: random() * Math.PI * 2,
      frequency: 0.42 + random() * 0.34
    };
  }

  function placeReservedParticle(particle, zone, sign, preferredX, preferredY) {
    var position = clearPositionNear(zone, particle.r, preferredX, preferredY);
    var velocity = particleVelocity(state.particleSerial + Math.round(state.elapsed * 1000));
    particle.zone = zone;
    particle.sign = sign;
    particle.x = position.x;
    particle.y = position.y;
    particle.vx = velocity.vx;
    particle.vy = velocity.vy;
    particle.phase = velocity.phase;
    particle.frequency = velocity.frequency;
    particle.hidden = false;
    particle.reservedBy = null;
  }

  function createFreeParticle(zone, sign, preferredX, preferredY, radius) {
    var position = clearPositionNear(zone, radius, preferredX, preferredY);
    var velocity = particleVelocity(state.particleSerial + Math.round(state.elapsed * 1000));
    var particle = {
      id: "bulk-" + state.particleSerial,
      zone: zone,
      sign: sign,
      x: position.x,
      y: position.y,
      vx: velocity.vx,
      vy: velocity.vy,
      r: radius,
      phase: velocity.phase,
      frequency: velocity.frequency,
      hidden: false,
      reservedBy: null
    };
    state.particleSerial += 1;
    state.particles.push(particle);
    return particle;
  }

  function keepInsideZone(particle) {
    var bounds = zoneBounds(particle.zone);
    if (particle.x < bounds.xMin) {
      particle.x = bounds.xMin;
      particle.vx = Math.abs(particle.vx);
    } else if (particle.x > bounds.xMax) {
      particle.x = bounds.xMax;
      particle.vx = -Math.abs(particle.vx);
    }
    if (particle.y < bounds.yMin) {
      particle.y = bounds.yMin;
      particle.vy = Math.abs(particle.vy);
    } else if (particle.y > bounds.yMax) {
      particle.y = bounds.yMax;
      particle.vy = -Math.abs(particle.vy);
    }
  }

  function repelFromObstacles(particle) {
    var obstacles = zoneObstacles(particle.zone);
    for (var i = 0; i < obstacles.length; i += 1) {
      var rect = obstacles[i];
      var padding = particle.r + 5;
      if (!pointInsideExpandedRect(particle.x, particle.y, rect, padding)) {
        continue;
      }
      var leftDistance = Math.abs(particle.x - (rect.x - padding));
      var rightDistance = Math.abs(rect.x + rect.width + padding - particle.x);
      var topDistance = Math.abs(particle.y - (rect.y - padding));
      var bottomDistance = Math.abs(rect.y + rect.height + padding - particle.y);
      var nearest = Math.min(leftDistance, rightDistance, topDistance, bottomDistance);
      if (nearest === leftDistance) {
        particle.x = rect.x - padding;
        particle.vx = -Math.abs(particle.vx);
      } else if (nearest === rightDistance) {
        particle.x = rect.x + rect.width + padding;
        particle.vx = Math.abs(particle.vx);
      } else if (nearest === topDistance) {
        particle.y = rect.y - padding;
        particle.vy = -Math.abs(particle.vy);
      } else {
        particle.y = rect.y + rect.height + padding;
        particle.vy = Math.abs(particle.vy);
      }
      keepInsideZone(particle);
    }
  }

  function solveCollisions(iterations) {
    for (var pass = 0; pass < iterations; pass += 1) {
      for (var i = 0; i < state.particles.length; i += 1) {
        var first = state.particles[i];
        if (first.hidden) {
          continue;
        }
        for (var j = i + 1; j < state.particles.length; j += 1) {
          var second = state.particles[j];
          if (second.hidden || first.zone !== second.zone) {
            continue;
          }
          var dx = second.x - first.x;
          var dy = second.y - first.y;
          var minimum = first.r + second.r + 4;
          var distanceSquared = dx * dx + dy * dy;
          if (distanceSquared >= minimum * minimum) {
            continue;
          }
          var distance = Math.sqrt(distanceSquared);
          var nx;
          var ny;
          if (distance < 0.001) {
            var angle = ((i + 1) * 2.399 + (j + 1) * 0.71) % (Math.PI * 2);
            nx = Math.cos(angle);
            ny = Math.sin(angle);
            distance = 0;
          } else {
            nx = dx / distance;
            ny = dy / distance;
          }
          var correction = (minimum - distance) / 2 + 0.02;
          first.x -= nx * correction;
          first.y -= ny * correction;
          second.x += nx * correction;
          second.y += ny * correction;
          var relative = (second.vx - first.vx) * nx + (second.vy - first.vy) * ny;
          if (relative < 0) {
            var impulse = relative * 0.55;
            first.vx += nx * impulse;
            first.vy += ny * impulse;
            second.vx -= nx * impulse;
            second.vy -= ny * impulse;
          }
          keepInsideZone(first);
          keepInsideZone(second);
          repelFromObstacles(first);
          repelFromObstacles(second);
        }
      }
    }
  }

  function updateParticles(delta) {
    var motionScale = reducedMotion.matches ? 0.42 : 1;
    var maxSpeed = reducedMotion.matches ? 4.2 : 22;
    var acceleration = reducedMotion.matches ? 1.75 : 3.2;
    var minimumSpeed = reducedMotion.matches ? 1.8 : 3.2;
    var nudge = reducedMotion.matches ? 0.35 : 0.6;
    for (var i = 0; i < state.particles.length; i += 1) {
      var particle = state.particles[i];
      if (particle.hidden) {
        continue;
      }
      var clock = state.elapsed * particle.frequency + particle.phase;
      particle.vx += Math.cos(clock * 1.17) * acceleration * delta * motionScale;
      particle.vy += Math.sin(clock * 0.93) * acceleration * delta * motionScale;
      var speed = Math.hypot(particle.vx, particle.vy);
      if (speed > maxSpeed) {
        particle.vx = (particle.vx / speed) * maxSpeed;
        particle.vy = (particle.vy / speed) * maxSpeed;
      }
      if (speed < minimumSpeed) {
        particle.vx += Math.cos(clock) * nudge;
        particle.vy += Math.sin(clock) * nudge;
      }
      particle.x += particle.vx * delta;
      particle.y += particle.vy * delta;
      keepInsideZone(particle);
      repelFromObstacles(particle);
    }
    solveCollisions(3);
  }

  function surfaceSlotOrder() {
    var layout = state.layout;
    var radius = layout.surfaceRadius;
    var minimumX = 24 + radius;
    var maximumX = layout.width - 24 - radius;
    var step = radius * 2 + 3;
    var candidates = [];
    for (var x = minimumX; x <= maximumX; x += step) {
      var hitsChannel = Math.abs(x - layout.channelX) < layout.channelWidth / 2 + radius + 4;
      if (!hitsChannel) {
        candidates.push(x);
      }
    }
    if (!candidates.length) {
      return [];
    }

    var remaining = candidates.slice();
    var ordered = [];
    var firstIndex = 0;
    var firstDistance = Math.abs(remaining[0] - layout.channelX);
    for (var firstCandidate = 1; firstCandidate < remaining.length; firstCandidate += 1) {
      var channelDistance = Math.abs(remaining[firstCandidate] - layout.channelX);
      if (channelDistance < firstDistance) {
        firstIndex = firstCandidate;
        firstDistance = channelDistance;
      }
    }
    ordered.push(remaining.splice(firstIndex, 1)[0]);

    while (remaining.length) {
      var bestIndex = 0;
      var bestScore = -1;
      for (var candidateIndex = 0; candidateIndex < remaining.length; candidateIndex += 1) {
        var candidateX = remaining[candidateIndex];
        var nearestDistance = Infinity;
        for (var selectedIndex = 0; selectedIndex < ordered.length; selectedIndex += 1) {
          nearestDistance = Math.min(nearestDistance, Math.abs(candidateX - ordered[selectedIndex]));
        }
        if (
          nearestDistance > bestScore + 0.01 ||
          (Math.abs(nearestDistance - bestScore) <= 0.01 &&
            Math.abs(candidateX - layout.channelX) <
              Math.abs(remaining[bestIndex] - layout.channelX))
        ) {
          bestIndex = candidateIndex;
          bestScore = nearestDistance;
        }
      }
      ordered.push(remaining.splice(bestIndex, 1)[0]);
    }
    return ordered;
  }

  function makeSurfaceXs(count) {
    if (count <= 0) {
      return [];
    }
    return surfaceSlotOrder()
      .slice(0, count)
      .sort(function (a, b) {
        return a - b;
      });
  }

  function changedSurfaceSlot(smallerSet, largerSet) {
    for (var i = 0; i < largerSet.length; i += 1) {
      var candidate = largerSet[i];
      var alreadyPresent = smallerSet.some(function (existing) {
        return Math.abs(existing - candidate) < 0.5;
      });
      if (!alreadyPresent) {
        return candidate;
      }
    }
    return null;
  }

  function ionInventory() {
    var inventory = {
      outside: { positive: 0, negative: 0 },
      inside: { positive: 0, negative: 0 }
    };
    for (var i = 0; i < state.particles.length; i += 1) {
      var particle = state.particles[i];
      var key = particle.sign > 0 ? "positive" : "negative";
      inventory[particle.zone][key] += 1;
    }
    return inventory;
  }

  function spawnFlux() {
    if (!state.layout || state.flux) {
      return;
    }
    var transition = eventTransition(state.voltage, state.charge, state.direction);
    if (transition.blocked) {
      state.nextFluxAt = state.elapsed + 0.4;
      return;
    }
    var pairsAtStart = transition.beforePairs;
    var sourceZone = state.direction === 1 ? "outside" : "inside";
    var destinationZone = sourceZone === "outside" ? "inside" : "outside";
    var layout = state.layout;
    var destinationBounds = zoneBounds(destinationZone);
    var offsetSign = state.fluxSerial % 2 === 0 ? -1 : 1;
    var entry = {
      x: layout.channelX,
      y:
        sourceZone === "outside"
          ? layout.membraneY - layout.membraneHeight / 2 - layout.radius * 0.7
          : layout.membraneY + layout.membraneHeight / 2 + layout.radius * 0.7
    };
    var exit = {
      x: layout.channelX,
      y:
        destinationZone === "outside"
          ? layout.membraneY - layout.membraneHeight / 2 - layout.radius * 0.7
          : layout.membraneY + layout.membraneHeight / 2 + layout.radius * 0.7
    };
    var currentXs = makeSurfaceXs(pairsAtStart);
    var targetX;
    if (transition.mode === "neutralize") {
      targetX = changedSurfaceSlot(
        makeSurfaceXs(Math.max(0, pairsAtStart - 1)),
        currentXs
      );
    } else {
      targetX = changedSurfaceSlot(currentXs, makeSurfaceXs(pairsAtStart + 1));
    }
    if (targetX == null) {
      state.nextFluxAt = state.elapsed + 0.4;
      return;
    }
    var target = {
      x: targetX,
      y: destinationZone === "outside" ? layout.outsideSurfaceY : layout.insideSurfaceY
    };
    var sourceSurfaceY =
      sourceZone === "outside" ? layout.outsideSurfaceY : layout.insideSurfaceY;
    var fluxId = "flux-" + state.fluxSerial;
    var transportParticle = selectFreeParticle(sourceZone, state.charge, entry);
    var companionParticle = null;
    if (transition.mode === "separate") {
      companionParticle = selectFreeParticle(sourceZone, -state.charge, {
        x: target.x,
        y: sourceSurfaceY
      });
    }
    if (!transportParticle || (transition.mode === "separate" && !companionParticle)) {
      state.nextFluxAt = state.elapsed + 0.4;
      return;
    }
    var start = { x: transportParticle.x, y: transportParticle.y };
    var companionStart = companionParticle
      ? { x: companionParticle.x, y: companionParticle.y }
      : null;
    reserveParticle(transportParticle, fluxId);
    if (companionParticle) {
      reserveParticle(companionParticle, fluxId);
    }
    var finalPoint = {
      x: clamp(
        target.x + offsetSign * layout.radius * 2.8,
        destinationBounds.xMin + layout.radius * 2.2,
        destinationBounds.xMax - layout.radius * 2.2
      ),
      y:
        destinationZone === "outside"
          ? Math.max(destinationBounds.yMin + 30, destinationBounds.yMax - 82)
          : Math.min(destinationBounds.yMax - 30, destinationBounds.yMin + 82)
    };
    var sourceBounds = zoneBounds(sourceZone);
    var releasePoint = {
      x: clamp(
        target.x - offsetSign * layout.radius * 2.8,
        sourceBounds.xMin + layout.radius * 2.2,
        sourceBounds.xMax - layout.radius * 2.2
      ),
      y:
        sourceZone === "outside"
          ? Math.max(sourceBounds.yMin + 30, sourceBounds.yMax - 82)
          : Math.min(sourceBounds.yMax - 30, sourceBounds.yMin + 82)
    };
    state.flux = {
      id: fluxId,
      ionSign: state.charge,
      direction: state.direction,
      sourceZone: sourceZone,
      destinationZone: destinationZone,
      mode: transition.mode,
      progress: 0,
      duration: FLUX_DURATION,
      commitAt: transition.mode === "neutralize" ? 0.58 : 0.68,
      committed: false,
      transition: transition,
      start: start,
      transportParticleId: transportParticle.id,
      companionParticleId: companionParticle ? companionParticle.id : null,
      companionStart: companionStart,
      companionTarget: companionParticle
        ? { x: target.x, y: sourceSurfaceY }
        : null,
      entry: entry,
      exit: exit,
      target: target,
      finalPoint: finalPoint,
      releaseStart: { x: target.x, y: sourceSurfaceY },
      releasePoint: releasePoint,
      voltageAtStart: state.voltage,
      inventoryBefore: ionInventory(),
      finalized: false,
      transitionRecord: null
    };
    state.fluxSerial += 1;
  }

  function cancelFlux() {
    if (!state.flux || state.flux.committed) {
      return;
    }
    var flux = state.flux;
    restoreReservedParticle(particleById(flux.transportParticleId), flux.id);
    restoreReservedParticle(particleById(flux.companionParticleId), flux.id);
    state.flux = null;
    state.lastFluxSnapshot = null;
    solveCollisions(2);
  }

  function finalizeFlux(flux) {
    if (!flux || flux.finalized) {
      return;
    }
    var transportParticle = particleById(flux.transportParticleId);
    if (flux.mode === "separate") {
      removeParticleById(flux.transportParticleId);
      removeParticleById(flux.companionParticleId);
    } else if (transportParticle) {
      var spacing = state.layout.radius * 1.18;
      var order = flux.ionSign > 0 ? 1 : -1;
      placeReservedParticle(
        transportParticle,
        flux.destinationZone,
        flux.ionSign,
        flux.finalPoint.x + spacing * order,
        flux.finalPoint.y
      );
      createFreeParticle(
        flux.destinationZone,
        -flux.ionSign,
        flux.finalPoint.x - spacing * order,
        flux.finalPoint.y,
        transportParticle.r
      );
      createFreeParticle(
        flux.sourceZone,
        flux.ionSign,
        flux.releasePoint.x,
        flux.releasePoint.y,
        transportParticle.r
      );
    }
    flux.finalized = true;
    solveCollisions(5);
    if (flux.transitionRecord) {
      flux.transitionRecord.inventoryAfter = ionInventory();
    }
  }

  function commitFlux(flux) {
    if (!flux || flux.committed) {
      return;
    }
    flux.committed = true;
    var transition = flux.transition;
    state.voltage = transition.afterVoltage;
    var record = {
      eventId: flux.id,
      time: state.elapsed,
      charge: flux.ionSign,
      direction: flux.direction,
      mode: flux.mode,
      effect: transition.effect,
      beforeVoltage: transition.beforeVoltage,
      afterVoltage: transition.afterVoltage,
      beforePairs: transition.beforePairs,
      afterPairs: transition.afterPairs,
      beforeOutsideSign: transition.beforeOutsideSign,
      beforeInsideSign: transition.beforeInsideSign,
      afterOutsideSign: transition.afterOutsideSign,
      afterInsideSign: transition.afterInsideSign,
      targetX: flux.target.x,
      transportParticleId: flux.transportParticleId,
      companionParticleId: flux.companionParticleId,
      inventoryBefore: flux.inventoryBefore,
      inventoryAfter: null
    };
    flux.transitionRecord = record;
    state.transitions.push(record);
    if (state.transitions.length > 30) {
      state.transitions.shift();
    }
    state.history.push({ t: state.elapsed, v: transition.beforeVoltage });
    state.history.push({ t: state.elapsed, v: transition.afterVoltage });
    state.historyClock = 0;
    var guidedFlux =
      state.stageSession &&
      isGuidedDepolarization(flux.ionSign, flux.direction) &&
      isGuidedDepolarization(state.charge, state.direction);
    if (guidedFlux && transition.afterVoltage === -VOLTAGE_STEP) {
      pauseAtStageBoundary("before-zero");
    } else if (guidedFlux && transition.afterVoltage === 0) {
      pauseAtStageBoundary("at-zero");
    } else {
      updateStageIndicator();
    }
  }

  function updateFlux(delta) {
    if (state.flux) {
      state.flux.progress += delta / state.flux.duration;
      if (!state.flux.committed && state.flux.progress >= state.flux.commitAt) {
        commitFlux(state.flux);
      }
      if (state.flux.progress >= 1) {
        finalizeFlux(state.flux);
        state.flux = null;
        state.lastFluxSnapshot = null;
        state.nextFluxAt = state.isRunning ? state.elapsed + FLUX_GAP : Infinity;
      }
    }
    if (state.isRunning && !state.flux && state.elapsed >= state.nextFluxAt) {
      spawnFlux();
    }
  }

  function updateHistory(delta) {
    state.historyClock += delta;
    if (state.historyClock >= 0.1) {
      state.historyClock = 0;
      state.history.push({ t: state.elapsed, v: state.voltage });
      var cutoff = state.elapsed - 42;
      while (state.history.length > 2 && state.history[1].t < cutoff) {
        state.history.shift();
      }
    }
  }

  function drawFluidBackground(context, layout) {
    var outsideGradient = context.createLinearGradient(0, 0, 0, layout.membrane.y);
    outsideGradient.addColorStop(0, "#eef8fd");
    outsideGradient.addColorStop(1, "#e7f4f8");
    context.fillStyle = outsideGradient;
    context.fillRect(0, 0, layout.width, layout.membrane.y);

    var insideGradient = context.createLinearGradient(
      0,
      layout.membrane.y + layout.membrane.height,
      0,
      layout.height
    );
    insideGradient.addColorStop(0, "#fbfbf2");
    insideGradient.addColorStop(1, "#f5f7eb");
    context.fillStyle = insideGradient;
    context.fillRect(
      0,
      layout.membrane.y + layout.membrane.height,
      layout.width,
      layout.height - layout.membrane.y - layout.membrane.height
    );
  }

  function drawIon(context, x, y, radius, sign, alpha, scale) {
    var drawRadius = radius * (scale || 1);
    context.save();
    context.globalAlpha = alpha == null ? 1 : alpha;
    context.shadowColor = "rgba(16, 39, 34, 0.20)";
    context.shadowBlur = 6;
    context.shadowOffsetY = 3;
    var gradient = context.createRadialGradient(
      x - drawRadius * 0.34,
      y - drawRadius * 0.38,
      drawRadius * 0.1,
      x,
      y,
      drawRadius
    );
    if (sign > 0) {
      gradient.addColorStop(0, "#ff8585");
      gradient.addColorStop(0.48, COLORS.positive);
      gradient.addColorStop(1, COLORS.positiveDark);
    } else {
      gradient.addColorStop(0, "#6ca7ed");
      gradient.addColorStop(0.48, COLORS.negative);
      gradient.addColorStop(1, COLORS.negativeDark);
    }
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(x, y, drawRadius, 0, Math.PI * 2);
    context.fill();
    context.shadowColor = "transparent";
    context.strokeStyle = sign > 0 ? "#8a2323" : "#174b86";
    context.lineWidth = Math.max(1, drawRadius * 0.075);
    context.stroke();

    context.fillStyle = "#fff";
    context.font = "800 " + Math.round(drawRadius * 1.16) + "px Arial, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.direction = "ltr";
    context.fillText(sign > 0 ? "+" : "−", x, y + drawRadius * 0.03);
    context.restore();
  }

  function drawParticles(context) {
    for (var i = 0; i < state.particles.length; i += 1) {
      var particle = state.particles[i];
      if (particle.hidden) {
        continue;
      }
      drawIon(context, particle.x, particle.y, particle.r, particle.sign, 1, 1);
    }
  }

  function drawMembrane(context, layout) {
    context.save();
    context.shadowColor = "rgba(55, 105, 20, 0.18)";
    context.shadowBlur = 8;
    context.shadowOffsetY = 2;
    var gradient = context.createLinearGradient(
      0,
      layout.membrane.y,
      0,
      layout.membrane.y + layout.membrane.height
    );
    gradient.addColorStop(0, COLORS.membraneLight);
    gradient.addColorStop(0.25, COLORS.membrane);
    gradient.addColorStop(1, COLORS.membraneDark);
    context.fillStyle = gradient;
    context.fillRect(
      layout.membrane.x,
      layout.membrane.y,
      layout.membrane.width,
      layout.membrane.height
    );
    context.shadowColor = "transparent";
    context.strokeStyle = "rgba(61, 119, 20, 0.72)";
    context.lineWidth = 1.5;
    context.beginPath();
    context.moveTo(0, layout.membrane.y + 0.75);
    context.lineTo(layout.width, layout.membrane.y + 0.75);
    context.moveTo(0, layout.membrane.y + layout.membrane.height - 0.75);
    context.lineTo(layout.width, layout.membrane.y + layout.membrane.height - 0.75);
    context.stroke();

    context.fillStyle = "#fff";
    context.font = "800 " + (layout.mobile ? 15 : 17) + "px Arial, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.direction = "rtl";
    context.fillText(
      "ממברנה",
      layout.membraneLabel.x + layout.membraneLabel.width / 2,
      layout.membraneY + 1
    );
    context.restore();
  }

  function drawChannel(context, layout) {
    var channel = layout.channel;
    context.save();
    context.shadowColor = "rgba(20, 65, 51, 0.2)";
    context.shadowBlur = 7;
    roundedRect(context, channel.x, channel.y, channel.width, channel.height, channel.width * 0.38);
    context.fillStyle = "#eaf6ef";
    context.fill();
    context.shadowColor = "transparent";
    context.strokeStyle = "#367a5c";
    context.lineWidth = Math.max(3, layout.radius * 0.24);
    context.stroke();

    var tunnelWidth = channel.width * 0.3;
    roundedRect(
      context,
      layout.channelX - tunnelWidth / 2,
      channel.y + 4,
      tunnelWidth,
      channel.height - 8,
      tunnelWidth / 2
    );
    context.fillStyle = "rgba(255,255,255,0.93)";
    context.fill();
    context.strokeStyle = "rgba(82, 142, 112, 0.28)";
    context.lineWidth = 1;
    context.stroke();
    context.restore();
  }

  function drawSurfaceCharges(context, layout) {
    var count = surfacePairs(state.voltage);
    var xs;
    if (state.flux && state.flux.committed && state.flux.mode === "neutralize") {
      xs = makeSurfaceXs(Math.min(MAX_SURFACE_PAIRS, count + 1));
      if (xs.length) {
        var removeIndex = 0;
        var removeDistance = Math.abs(xs[0] - state.flux.target.x);
        for (var candidateIndex = 1; candidateIndex < xs.length; candidateIndex += 1) {
          var candidateDistance = Math.abs(xs[candidateIndex] - state.flux.target.x);
          if (candidateDistance < removeDistance) {
            removeIndex = candidateIndex;
            removeDistance = candidateDistance;
          }
        }
        xs.splice(removeIndex, 1);
      }
    } else if (state.flux && state.flux.committed && state.flux.mode === "separate") {
      xs = makeSurfaceXs(Math.max(0, count - 1));
    } else {
      xs = makeSurfaceXs(count);
    }
    var polarity = signOf(state.voltage);
    var outsideSign = polarity === 0 ? 0 : -polarity;
    var insideSign = polarity;
    var surface = [];
    for (var i = 0; i < xs.length; i += 1) {
      if (outsideSign) {
        drawIon(context, xs[i], layout.outsideSurfaceY, layout.surfaceRadius, outsideSign, 1, 1);
        surface.push({
          id: "surface-out-" + i,
          x: xs[i],
          y: layout.outsideSurfaceY,
          r: layout.surfaceRadius,
          side: "outside",
          sign: outsideSign,
          claimed: false
        });
      }
      if (insideSign) {
        drawIon(context, xs[i], layout.insideSurfaceY, layout.surfaceRadius, insideSign, 1, 1);
        surface.push({
          id: "surface-in-" + i,
          x: xs[i],
          y: layout.insideSurfaceY,
          r: layout.surfaceRadius,
          side: "inside",
          sign: insideSign,
          claimed: false
        });
      }
    }
    state.lastSurface = surface;
  }

  function fluxGeometry(flux) {
    var p = clamp(flux.progress, 0, 1);
    var radius = state.layout.radius;
    var ion = { x: flux.start.x, y: flux.start.y };
    var partner = null;
    var sourceCompanion = null;
    var sourceRelease = null;
    var phase = "approach";
    var alpha = 1;

    if (flux.mode === "separate" && flux.companionStart && flux.companionTarget) {
      sourceCompanion = pointLerp(
        flux.companionStart,
        flux.companionTarget,
        p / flux.commitAt
      );
      sourceCompanion.sign = -flux.ionSign;
    }

    if (p < 0.22) {
      ion = pointLerp(flux.start, flux.entry, p / 0.22);
      phase = "approach";
    } else if (p < 0.46) {
      ion = pointLerp(flux.entry, flux.exit, (p - 0.22) / 0.24);
      phase = "cross";
    } else if (flux.mode === "neutralize") {
      if (p < 0.58) {
        ion = pointLerp(flux.exit, flux.target, (p - 0.46) / 0.12);
        phase = "seek";
      } else {
        var midpoint;
        if (p < 0.7) {
          midpoint = flux.target;
          phase = "bond";
        } else {
          midpoint = pointLerp(flux.target, flux.finalPoint, (p - 0.7) / 0.3);
          phase = "depart";
        }
        var spacing = radius * 1.06;
        var order = flux.ionSign > 0 ? 1 : -1;
        ion = {
          x: midpoint.x + spacing * order,
          y: midpoint.y
        };
        partner = {
          x: midpoint.x - spacing * order,
          y: midpoint.y,
          sign: -flux.ionSign
        };
      }
      if (p >= flux.commitAt) {
        sourceRelease = pointLerp(
          flux.releaseStart,
          flux.releasePoint,
          (p - flux.commitAt) / (1 - flux.commitAt)
        );
        sourceRelease.sign = flux.ionSign;
      }
    } else {
      if (p < 0.72) {
        ion = pointLerp(flux.exit, flux.target, (p - 0.46) / 0.26);
        phase = "settle";
      } else {
        ion = flux.target;
        phase = "separate";
      }
    }

    return {
      ion: ion,
      partner: partner,
      sourceCompanion: sourceCompanion,
      sourceRelease: sourceRelease,
      phase: phase,
      alpha: clamp(alpha, 0, 1)
    };
  }

  function drawFlux(context, layout) {
    if (!state.flux) {
      state.lastFluxSnapshot = null;
      return;
    }
    var flux = state.flux;
    var geometry = fluxGeometry(flux);
    var radius = layout.radius;
    if (geometry.sourceCompanion) {
      drawIon(
        context,
        geometry.sourceCompanion.x,
        geometry.sourceCompanion.y,
        radius,
        geometry.sourceCompanion.sign,
        geometry.alpha,
        1
      );
    }
    if (geometry.sourceRelease) {
      drawIon(
        context,
        geometry.sourceRelease.x,
        geometry.sourceRelease.y,
        radius,
        geometry.sourceRelease.sign,
        geometry.alpha,
        1
      );
    }
    if (geometry.partner) {
      context.save();
      context.strokeStyle = "rgba(41, 69, 63, 0.56)";
      context.lineWidth = Math.max(2, radius * 0.18);
      context.beginPath();
      context.moveTo(geometry.ion.x, geometry.ion.y);
      context.lineTo(geometry.partner.x, geometry.partner.y);
      context.stroke();
      context.restore();
      drawIon(
        context,
        geometry.partner.x,
        geometry.partner.y,
        radius,
        geometry.partner.sign,
        geometry.alpha,
        1
      );
    }
    drawIon(
      context,
      geometry.ion.x,
      geometry.ion.y,
      radius,
      flux.ionSign,
      geometry.alpha,
      1.04
    );

    state.lastFluxSnapshot = {
      id: flux.id,
      phase: geometry.phase,
      mode: flux.mode,
      committed: flux.committed,
      ionSign: flux.ionSign,
      x: geometry.ion.x,
      y: geometry.ion.y,
      targetX: flux.target.x,
      targetY: flux.target.y,
      sourceZone: flux.sourceZone,
      partnerId: geometry.partner ? flux.id + "-partner" : null,
      partnerX: geometry.partner ? geometry.partner.x : null,
      partnerY: geometry.partner ? geometry.partner.y : null,
      transportParticleId: flux.transportParticleId,
      companionParticleId: flux.companionParticleId,
      transportStart: { x: flux.start.x, y: flux.start.y },
      companionStart: flux.companionStart
        ? { x: flux.companionStart.x, y: flux.companionStart.y }
        : null,
      companionX: geometry.sourceCompanion ? geometry.sourceCompanion.x : null,
      companionY: geometry.sourceCompanion ? geometry.sourceCompanion.y : null,
      releaseX: geometry.sourceRelease ? geometry.sourceRelease.x : null,
      releaseY: geometry.sourceRelease ? geometry.sourceRelease.y : null,
      destinationZone: flux.destinationZone,
      beforePairs: flux.transition.beforePairs,
      afterPairs: flux.transition.afterPairs
    };
  }

  function drawCompartmentLabel(context, rect, text) {
    context.save();
    roundedRect(context, rect.x, rect.y, rect.width, rect.height, 11);
    context.fillStyle = "rgba(255,255,255,0.88)";
    context.fill();
    context.strokeStyle = "rgba(90, 117, 109, 0.22)";
    context.lineWidth = 1;
    context.stroke();
    context.fillStyle = "#385850";
    context.font = "800 14px Arial, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.direction = "rtl";
    context.fillText(text, rect.x + rect.width / 2, rect.y + rect.height / 2 + 1);
    context.restore();
  }

  function drawWiresAndElectrodes(context, layout) {
    var meter = layout.meter;
    var scale = meter.scale;
    var black = layout.blackJack;
    var red = layout.redJack;
    var outside = layout.outsideElectrode;
    var inside = layout.insideElectrode;

    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";

    context.strokeStyle = "#1f2927";
    context.lineWidth = 4.2 * scale;
    context.beginPath();
    context.moveTo(black.x, black.y);
    context.bezierCurveTo(
      meter.x - 18 * scale,
      meter.y + meter.height + 24 * scale,
      outside.x + 34 * scale,
      outside.yTop - 28 * scale,
      outside.x,
      outside.yTop
    );
    context.stroke();

    context.strokeStyle = "#d94141";
    context.lineWidth = 4.2 * scale;
    context.beginPath();
    context.moveTo(red.x, red.y);
    context.bezierCurveTo(
      layout.width - 6 * scale,
      meter.y + meter.height + 34 * scale,
      inside.xHead + 46 * scale,
      inside.yHead - 28 * scale,
      inside.xHead,
      inside.yHead
    );
    context.stroke();

    context.strokeStyle = "#263633";
    context.lineWidth = 7 * scale;
    context.beginPath();
    context.moveTo(outside.x, outside.yTop);
    context.lineTo(outside.x, outside.yTip - 14 * scale);
    context.stroke();
    context.strokeStyle = "#aebeb9";
    context.lineWidth = 3 * scale;
    context.beginPath();
    context.moveTo(outside.x, outside.yTip - 16 * scale);
    context.lineTo(outside.x, outside.yTip);
    context.stroke();

    context.strokeStyle = "rgba(238, 249, 248, 0.94)";
    context.lineWidth = 9 * scale;
    context.beginPath();
    context.moveTo(inside.xHead, inside.yHead);
    context.lineTo(inside.xTip, inside.yTip - 12 * scale);
    context.stroke();
    context.strokeStyle = "#6e8580";
    context.lineWidth = 1.6 * scale;
    context.beginPath();
    context.moveTo(inside.xHead, inside.yHead);
    context.lineTo(inside.xTip, inside.yTip - 12 * scale);
    context.stroke();
    context.fillStyle = "#cdd9d6";
    context.beginPath();
    context.moveTo(inside.xTip - 3 * scale, inside.yTip - 14 * scale);
    context.lineTo(inside.xTip + 3 * scale, inside.yTip - 14 * scale);
    context.lineTo(inside.xTip, inside.yTip);
    context.closePath();
    context.fill();
    context.restore();
  }

  function drawMultimeter(context, layout) {
    var meter = layout.meter;
    var scale = meter.scale;
    var x = meter.x;
    var y = meter.y;
    var width = meter.width;
    var height = meter.height;

    context.save();
    context.shadowColor = "rgba(18, 41, 35, 0.28)";
    context.shadowBlur = 12 * scale;
    context.shadowOffsetY = 5 * scale;
    roundedRect(context, x, y, width, height, 16 * scale);
    context.fillStyle = "#27322f";
    context.fill();
    context.shadowColor = "transparent";
    context.strokeStyle = "#101815";
    context.lineWidth = 2 * scale;
    context.stroke();

    roundedRect(
      context,
      x + 11 * scale,
      y + 12 * scale,
      width - 22 * scale,
      51 * scale,
      7 * scale
    );
    context.fillStyle = "#b9d7bd";
    context.fill();
    context.strokeStyle = "#0d1714";
    context.lineWidth = 2 * scale;
    context.stroke();

    context.fillStyle = "#17251f";
    context.font = "800 " + Math.round(20 * scale) + "px Consolas, monospace";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.direction = "ltr";
    context.fillText(
      formatVoltage(state.voltage).replace(" mV", ""),
      x + width / 2,
      y + 35 * scale
    );
    context.font = "700 " + Math.round(8.5 * scale) + "px Arial, sans-serif";
    context.textAlign = "right";
    context.fillText("mV", x + width - 16 * scale, y + 53 * scale);

    context.fillStyle = "#111b18";
    context.beginPath();
    context.arc(x + width / 2, y + 103 * scale, 28 * scale, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = "#62716d";
    context.lineWidth = 3 * scale;
    context.stroke();
    context.save();
    context.translate(x + width / 2, y + 103 * scale);
    context.rotate(-0.7);
    context.fillStyle = "#dbe4e1";
    roundedRect(context, -4 * scale, -22 * scale, 8 * scale, 25 * scale, 3 * scale);
    context.fill();
    context.restore();

    context.fillStyle = "#e8efed";
    context.font = "700 " + Math.round(7.5 * scale) + "px Arial, sans-serif";
    context.textAlign = "center";
    context.fillText("V", layout.redJack.x, layout.redJack.y - 15 * scale);
    context.fillText("COM", layout.blackJack.x, layout.blackJack.y - 15 * scale);

    context.fillStyle = "#0e1714";
    context.beginPath();
    context.arc(layout.blackJack.x, layout.blackJack.y, 8 * scale, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#df4747";
    context.beginPath();
    context.arc(layout.redJack.x, layout.redJack.y, 8 * scale, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#090d0c";
    context.beginPath();
    context.arc(layout.blackJack.x, layout.blackJack.y, 3.2 * scale, 0, Math.PI * 2);
    context.arc(layout.redJack.x, layout.redJack.y, 3.2 * scale, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  function drawScene() {
    var layout = state.layout;
    if (!layout) {
      return;
    }
    var context = membraneContext;
    context.clearRect(0, 0, layout.width, layout.height);
    drawFluidBackground(context, layout);
    drawParticles(context);
    drawMembrane(context, layout);
    drawSurfaceCharges(context, layout);
    drawChannel(context, layout);
    drawFlux(context, layout);
    drawWiresAndElectrodes(context, layout);
    drawMultimeter(context, layout);
    drawCompartmentLabel(context, layout.outsideLabel, "נוזל חוץ־תאי");
    drawCompartmentLabel(context, layout.insideLabel, "ציטופלסמה");
  }

  function drawGraph() {
    var context = graphContext;
    var width = state.graphSize.width;
    var height = state.graphSize.height;
    if (!width || !height) {
      return;
    }
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#fbfdfc";
    context.fillRect(0, 0, width, height);

    var margin = {
      left: width < 330 ? 31 : 36,
      right: 8,
      top: 7,
      bottom: 20
    };
    var plot = {
      x: margin.left,
      y: margin.top,
      width: width - margin.left - margin.right,
      height: height - margin.top - margin.bottom
    };
    var minVoltage = -105;
    var maxVoltage = 105;
    var windowSeconds = 20;
    var maxTime = Math.max(windowSeconds, state.elapsed);
    var minTime = maxTime - windowSeconds;

    function graphY(value) {
      return (
        plot.y +
        ((maxVoltage - clamp(value, minVoltage, maxVoltage)) /
          (maxVoltage - minVoltage)) *
          plot.height
      );
    }

    function graphX(time) {
      return plot.x + ((time - minTime) / windowSeconds) * plot.width;
    }

    context.save();
    context.font = "10px Arial, sans-serif";
    context.textAlign = "right";
    context.textBaseline = "middle";
    context.direction = "ltr";
    var gridValues = [-100, -70, -50, 0, 50, 100];
    for (var i = 0; i < gridValues.length; i += 1) {
      var value = gridValues[i];
      var y = graphY(value);
      context.beginPath();
      if (value === 0) {
        context.setLineDash([5, 4]);
        context.strokeStyle = "rgba(38, 61, 55, 0.52)";
        context.lineWidth = 1.2;
      } else if (value === -70) {
        context.setLineDash([3, 4]);
        context.strokeStyle = "rgba(19, 124, 105, 0.52)";
        context.lineWidth = 1.15;
      } else {
        context.setLineDash([]);
        context.strokeStyle = "rgba(93, 119, 112, 0.16)";
        context.lineWidth = 1;
      }
      context.moveTo(plot.x, y);
      context.lineTo(plot.x + plot.width, y);
      context.stroke();
      context.setLineDash([]);
      context.fillStyle = value === -70 ? "#137c69" : "#758983";
      context.fillText(String(value), plot.x - 5, y);
    }

    context.fillStyle = "#70847e";
    context.textAlign = "center";
    context.textBaseline = "top";
    context.fillText("20−", plot.x, plot.y + plot.height + 5);
    context.fillText("0 s", plot.x + plot.width, plot.y + plot.height + 5);

    context.save();
    context.beginPath();
    context.rect(plot.x, plot.y, plot.width, plot.height);
    context.clip();

    var points = state.history.filter(function (point) {
      return point.t >= minTime - 0.1;
    });
    if (points.length) {
      context.beginPath();
      for (var pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
        var point = points[pointIndex];
        var x = graphX(point.t);
        var pointY = graphY(point.v);
        if (pointIndex === 0) {
          context.moveTo(x, pointY);
        } else {
          context.lineTo(x, pointY);
        }
      }
      context.strokeStyle = COLORS.traceGlow;
      context.lineWidth = 6;
      context.lineCap = "round";
      context.lineJoin = "round";
      context.stroke();
      context.strokeStyle = COLORS.trace;
      context.lineWidth = 2.25;
      context.stroke();

      var latest = points[points.length - 1];
      context.fillStyle = COLORS.trace;
      context.beginPath();
      context.arc(graphX(latest.t), graphY(latest.v), 3.4, 0, Math.PI * 2);
      context.fill();
    }
    context.restore();

    context.strokeStyle = "rgba(64, 91, 84, 0.28)";
    context.lineWidth = 1;
    context.strokeRect(plot.x + 0.5, plot.y + 0.5, plot.width - 1, plot.height - 1);
    context.restore();
  }

  function updateReadouts(delta) {
    voltageOutput.textContent = formatVoltage(state.voltage);
    state.ariaClock += delta;
    if (state.ariaClock >= 0.9) {
      state.ariaClock = 0;
      membraneCanvas.setAttribute(
        "aria-label",
        "מתח הממברנה " +
          formatVoltage(state.voltage) +
          ". שתי אלקטרודות מחוברות למולטימטר; יונים נעים בנוזל החוץ תאי ובציטופלסמה."
      );
      graphCanvas.setAttribute(
        "aria-label",
        "גרף מתח ממברנה לאורך זמן. הערך הנוכחי " + formatVoltage(state.voltage)
      );
    }
  }

  function updateStageIndicator() {
    var guidedSelection = isGuidedDepolarization(state.charge, state.direction);
    var visible = state.stageSession && guidedSelection;
    if (!visible) {
      stageIndicator.hidden = true;
      stageContinueButton.hidden = true;
      stageIndicator.classList.remove("stage-1", "stage-2", "stage-3", "needs-continue", "stage-pop");
      stageIndicator.dataset.stageKey = "";
      return;
    }

    var stageNumber = stageNumberForVoltage(state.voltage);
    var labels = {
      1: "שלב ראשון",
      2: "שלב שני",
      3: "שלב שלישי"
    };
    var key = String(stageNumber) + ":" + (state.stageGate || "running");
    stageIndicator.hidden = false;
    stageLabel.textContent = labels[stageNumber];
    stageIndicator.classList.remove("stage-1", "stage-2", "stage-3", "needs-continue");
    stageIndicator.classList.add("stage-" + stageNumber);
    stageIndicator.classList.toggle("needs-continue", Boolean(state.stageGate));
    stageContinueButton.hidden = !state.stageGate;
    if (state.stageGate) {
      stageContinueButton.setAttribute(
        "aria-label",
        state.stageGate === "before-zero" ? "המשך לשלב השני" : "המשך לשלב השלישי"
      );
    }
    if (stageIndicator.dataset.stageKey !== key) {
      stageIndicator.dataset.stageKey = key;
      stageIndicator.classList.remove("stage-pop");
      void stageIndicator.offsetWidth;
      stageIndicator.classList.add("stage-pop");
    }
  }

  function pauseAtStageBoundary(gate) {
    state.stageGate = gate;
    state.stageSession = true;
    state.isRunning = false;
    state.nextFluxAt = Infinity;
    updateCurrentButton();
    updateStageIndicator();
  }

  function onControlChange() {
    var selectedCharge = document.querySelector('input[name="charge"]:checked');
    var selectedDirection = document.querySelector('input[name="direction"]:checked');
    state.charge = Number(selectedCharge.value);
    state.direction = Number(selectedDirection.value);
    if (!isGuidedDepolarization(state.charge, state.direction)) {
      state.stageSession = false;
      state.stageGate = null;
    } else if (state.isRunning) {
      state.stageSession = true;
    }
    updateCurrentButton();
    updateStageIndicator();
  }

  function updateCurrentButton() {
    toggleCurrentButton.classList.toggle("is-running", state.isRunning);
    toggleCurrentButton.setAttribute("aria-pressed", state.isRunning ? "true" : "false");
    toggleCurrentButton.setAttribute(
      "aria-label",
      state.isRunning ? "עצירת הזרם" : "הפעלת הזרם"
    );
    currentButtonLabel.textContent = state.isRunning ? "עצור זרם" : "הפעל זרם";
    currentButtonIcon.textContent = state.isRunning ? "■" : "▶";
    toggleCurrentButton.disabled = Boolean(state.stageGate);
  }

  function setCurrentRunning(running) {
    var nextState = Boolean(running);
    if (nextState && state.stageGate) {
      return;
    }
    if (state.isRunning === nextState) {
      return;
    }
    state.isRunning = nextState;
    if (state.isRunning) {
      state.stageSession = isGuidedDepolarization(state.charge, state.direction);
      state.nextFluxAt = state.elapsed + START_DELAY;
    } else {
      state.nextFluxAt = Infinity;
      if (state.flux && !state.flux.committed) {
        cancelFlux();
      }
    }
    updateCurrentButton();
    updateStageIndicator();
  }

  function resetSimulation() {
    document.getElementById("charge-positive").checked = true;
    document.getElementById("direction-in").checked = true;
    state.voltage = -70;
    state.isRunning = false;
    state.stageSession = false;
    state.stageGate = null;
    state.elapsed = 0;
    state.history = [{ t: 0, v: -70 }];
    state.historyClock = 0;
    state.flux = null;
    state.fluxSerial = 0;
    state.nextFluxAt = Infinity;
    state.transitions = [];
    state.lastSurface = [];
    state.lastFluxSnapshot = null;
    state.ariaClock = 0;
    state.resetEpoch += 1;
    state.lastTime = performance.now();
    onControlChange();
    updateCurrentButton();
    updateStageIndicator();
    initializeParticles();
    drawScene();
    drawGraph();
    updateReadouts(0);
  }

  function frame(now) {
    var delta = clamp((now - state.lastTime) / 1000, 0, 1 / 30);
    state.lastTime = now;
    state.elapsed += delta;
    updateParticles(delta);
    updateHistory(delta);
    updateFlux(delta);
    drawScene();
    drawGraph();
    updateReadouts(delta);
    requestAnimationFrame(frame);
  }

  function serializeRect(rect) {
    if (!rect) {
      return null;
    }
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height
    };
  }

  function debugSnapshot() {
    var layout = state.layout;
    return {
      voltage: Number(state.voltage.toFixed(4)),
      time: Number(state.elapsed.toFixed(4)),
      isRunning: state.isRunning,
      stageSession: state.stageSession,
      stageGate: state.stageGate,
      stageNumber:
        state.stageSession && isGuidedDepolarization(state.charge, state.direction)
          ? stageNumberForVoltage(state.voltage)
          : null,
      selection: {
        charge: state.charge,
        direction: state.direction
      },
      particles: state.particles.map(function (particle) {
          return {
            id: particle.id,
            x: particle.x,
            y: particle.y,
            r: particle.r,
            zone: particle.zone,
            sign: particle.sign,
            vx: particle.vx,
            vy: particle.vy,
            hidden: particle.hidden,
            reservedBy: particle.reservedBy
          };
        }),
      ionInventory: ionInventory(),
      surface: state.lastSurface.slice(),
      surfacePairs: surfacePairs(state.voltage),
      visualSurfacePairs:
        state.lastSurface.length / 2 +
        (state.flux && state.flux.committed && state.flux.mode === "separate" ? 1 : 0),
      surfaceOutsideSign: state.voltage === 0 ? 0 : -signOf(state.voltage),
      surfaceInsideSign: signOf(state.voltage),
      eventSerial: state.fluxSerial,
      commitSerial: state.transitions.length,
      resetEpoch: state.resetEpoch,
      transitions: state.transitions.map(function (transition) {
        return Object.assign({}, transition);
      }),
      flux: state.lastFluxSnapshot ? [Object.assign({}, state.lastFluxSnapshot)] : [],
      layout: layout
        ? {
            outside: Object.assign({}, layout.outside),
            inside: Object.assign({}, layout.inside),
            surfaceRadius: layout.surfaceRadius,
            surfaceSlotCapacity: surfaceSlotOrder().length,
            stageBadge: serializeRect(layout.stageBadge),
            membrane: serializeRect(layout.membrane),
            label: serializeRect(layout.membraneLabel),
            channel: serializeRect(layout.channel),
            meter: serializeRect(layout.meter),
            graph: {
              x: 0,
              y: 0,
              width: state.graphSize.width,
              height: state.graphSize.height
            },
            electrodeOutside: {
              x: layout.outsideElectrode.x,
              yTop: layout.outsideElectrode.yTop,
              yTip: layout.outsideElectrode.yTip
            },
            electrodeInside: Object.assign({}, layout.insideElectrode),
            redJack: Object.assign({}, layout.redJack),
            blackJack: Object.assign({}, layout.blackJack)
          }
        : null,
      graphPoints: state.history.map(function (point) {
        return { t: point.t, v: point.v };
      })
    };
  }

  document.querySelectorAll('input[name="charge"], input[name="direction"]').forEach(function (input) {
    input.addEventListener("change", onControlChange);
  });
  toggleCurrentButton.addEventListener("click", function () {
    setCurrentRunning(!state.isRunning);
  });
  stageContinueButton.addEventListener("click", function () {
    if (!state.stageGate) {
      return;
    }
    state.stageGate = null;
    updateCurrentButton();
    updateStageIndicator();
    setCurrentRunning(true);
  });
  resetButton.addEventListener("click", resetSimulation);

  var resizeTimer = 0;
  window.addEventListener("resize", function () {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(resizeAll, 80);
  });
  reducedMotion.addEventListener("change", initializeParticles);

  window.__MEMBRANE_MODEL__ = {
    effectSign: effectSign,
    eventTransition: eventTransition,
    surfacePairs: surfacePairs,
    voltageStep: VOLTAGE_STEP,
    maxSurfacePairs: MAX_SURFACE_PAIRS
  };
  window.__MEMBRANE_DEBUG__ = debugSnapshot;

  onControlChange();
  updateCurrentButton();
  updateStageIndicator();
  resizeAll();
  drawScene();
  drawGraph();
  requestAnimationFrame(frame);
})();
