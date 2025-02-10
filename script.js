/***************************************************
 * script.js
 * 
 * Debug version with console logs 
 * for investigating why ellipse might not be drawn.
 ***************************************************/

// -----------------------------------------------------------
// Utility functions (no ctx.transform())
// -----------------------------------------------------------

/**
 * Rotate a point (x, y) about the origin (0, 0) by `angle` radians.
 */
function rotatePoint(x, y, angle) {
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  return [
    x * cosA - y * sinA,
    x * sinA + y * cosA
  ];
}

function throttledLog(message) {
  let callCount = 0;

  return function(message) {
    callCount++;
    if (callCount % 10 === 0) {
      console.log(message);
      callCount = 0; // Reset for the next cycle of 10
    }
  };
}

const myLog = throttledLog();

/**
 * Shear a point (x, y) by shearX along x-axis, shearY along y-axis.
 * Shear matrix:
 *    [ 1      shearX ]
 *    [ shearY    1   ]
 */
function shearPoint(x, y, shearX, shearY) {
  return [
    x + shearX * y,
    y + shearY * x
  ];
}

/**
 * Given ellipseData, returns array of points approximating the ellipse
 * by sampling param t in [0..2π] and applying shear -> rotate -> translate.
 *
 * ellipseData = {
 *   centerX, centerY,
 *   radiusX, radiusY,
 *   rotation (radians),
 *   shearX, shearY,
 *   activeHandle
 * }
 */
function getEllipsePoints(ellipseData, steps = 60) {
  const { centerX, centerY, radiusX, radiusY, rotation, shearX, shearY } = ellipseData;
  const points = [];

  for (let i = 0; i <= steps; i++) {
    const t = (2 * Math.PI * i) / steps;
    // base ellipse in local coords
    let x = radiusX * Math.cos(t);
    let y = radiusY * Math.sin(t);

    // apply shear
    [x, y] = shearPoint(x, y, shearX, shearY);

    // apply rotation
    [x, y] = rotatePoint(x, y, rotation);

    // translate to center
    x += centerX;
    y += centerY;

    points.push({ x, y });
  }

  return points;
}

/**
 * Compute bounding box of the ellipse by sampling points and taking min/max.
 */
function getEllipseBoundingBox(ellipseData) {
  const pts = getEllipsePoints(ellipseData, 60);
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;

  pts.forEach(pt => {
    if (pt.x < minX) minX = pt.x;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.y > maxY) maxY = pt.y;
  });

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY
  };
}

/**
 * Check if (mx, my) is inside bounding box.
 */
function isPointInBox(mx, my, box) {
  return (
    mx >= box.x &&
    mx <= box.x + box.width &&
    my >= box.y &&
    my <= box.y + box.height
  );
}

/**
 * Check if (mx, my) is inside the ellipse by inverting
 * rotation and shear to get local coords, then check standard ellipse eqn.
 */
function isPointInEllipse(mx, my, ellipseData) {
  const { centerX, centerY, radiusX, radiusY, rotation, shearX, shearY } = ellipseData;

  // translate point to ellipse-centered
  let lx = mx - centerX;
  let ly = my - centerY;

  // invert rotation
  [lx, ly] = rotatePoint(lx, ly, -rotation);

  // invert shear (with matrix [1 shearX; shearY 1])
  const det = 1 - shearX * shearY;
  if (Math.abs(det) < 1e-10) {
    return false; // degenerate shear
  }
  // inverse matrix = (1/det) [ 1     -shearX ]
  //                           [ -shearY   1  ]
  const inv00 =  1 / det;
  const inv01 = -shearX / det;
  const inv10 = -shearY / det;
  const inv11 =  1 / det;

  const lxTemp = lx * inv00 + ly * inv01;
  const lyTemp = lx * inv10 + ly * inv11;
  lx = lxTemp;
  ly = lyTemp;

  // ellipse eqn in local coords => x^2/radiusX^2 + y^2/radiusY^2 <= 1
  const val = (lx * lx) / (radiusX * radiusX) + (ly * ly) / (radiusY * radiusY);
  return val <= 1;
}

/**
 * Return an array of 8 handle positions (corners + mid-sides) from bounding box.
 */
function getHandlesFromBox(box) {
  const { x, y, width, height } = box;
  const midX = x + width / 2;
  const midY = y + height / 2;

  return [
    // corners
    { x: x,         y: y,          role: 'top-left'     },
    { x: x + width, y: y,          role: 'top-right'    },
    { x: x,         y: y + height, role: 'bottom-left'  },
    { x: x + width, y: y + height, role: 'bottom-right' },

    // mid-sides
    { x: midX,      y: y,          role: 'top-middle'   },
    { x: midX,      y: y + height, role: 'bottom-middle'},
    { x: x,         y: midY,       role: 'left-middle'  },
    { x: x + width, y: midY,       role: 'right-middle' }
  ];
}

/**
 * Find if mouse is near a handle (simple distance check).
 */
function findHandleHit(handles, mx, my, radius = 6) {
  for (const handle of handles) {
    const dx = mx - handle.x;
    const dy = my - handle.y;
    if (dx * dx + dy * dy <= radius * radius) {
      return handle;
    }
  }
  return null;
}

/**
 * Small helper to draw a "cross" at (x,y) with a given size.
 */
function drawAnchorCross(ctx, x, y, size = 10) {
  ctx.beginPath();
  ctx.moveTo(x - size, y);
  ctx.lineTo(x + size, y);
  ctx.moveTo(x, y - size);
  ctx.lineTo(x, y + size);
  ctx.strokeStyle = 'magenta';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function computeEllipseCenterForBoxTopLeft(
  radiusX, radiusY, shearX, shearY, rotation,
  cornerType, cornerPoint ) {
  // 1) Make an ellipse data object with center at (0,0).
  const tempEllipse = {
    centerX: 0,
    centerY: 0,
    radiusX,
    radiusY,
    rotation,
    shearX,
    shearY
  };

  // 2) Get that bounding box
  const box = getEllipseBoundingBox(tempEllipse);

  let dx = 0;
  let dy = 0;
  switch(cornerType) {
  case 'top-left': 
    dx = cornerPoint.x - box.x;
    dy = cornerPoint.y - box.y;
    break;
  case 'top-right':
    dx = cornerPoint.x - (box.x + box.width);
    dy = cornerPoint.y - box.y;
    break;
  case 'bottom-right':
    dx = cornerPoint.x - (box.x + box.width);
    dy = cornerPoint.y - (box.y + box.height);
    break;
  case 'bottom-left':
    dx = cornerPoint.x - box.x;
    dy = cornerPoint.y - (box.y + box.height);
    break;
  }

  // 4) This shift is the new center
  return {
    centerX: dx,
    centerY: dy
  };
}

// -----------------------------------------------------------
// Main application
// -----------------------------------------------------------
const canvas = document.getElementById('myCanvas');
const ctx = canvas.getContext('2d');

let isDrawing = false;           // For initial 2-click ellipse creation
let ellipseData = {
  centerX: 0, centerY: 0,
  radiusX: 0, radiusY: 0,
  rotation: 0,
  shearX: 0,  shearY: 0,
  activeHandle: null
};
let hasEllipse = false;          // True after second click
let showBoundingBox = false;
let editMode = 'resize-shear';   // or 'rotate'
let isDragging = false;
let dragHandle = null;
let lastMousePos = { x: 0, y: 0 };

// We'll store a reference to the "anchor cross" for the current drag.
let activeAnchor = null;

canvas.addEventListener('mousedown', onMouseDown);
canvas.addEventListener('mousemove', onMouseMove);
canvas.addEventListener('mouseup', onMouseUp);
// Right-click context menu
canvas.addEventListener('contextmenu', onContextMenu);

function onMouseDown(e) {
  const { offsetX: mx, offsetY: my, button } = e;
  lastMousePos = { x: mx, y: my };

  // Right-click is handled separately
  if (button === 2) return;

  // If we do not have a finalized ellipse, we are in "creation" mode
  if (!hasEllipse) {
    if (!isDrawing) {
      // First click => set center
      ellipseData.centerX = mx;
      ellipseData.centerY = my;
      ellipseData.radiusX = 0;
      ellipseData.radiusY = 0;
      isDrawing = true;
    } else {
      // Second click => finalize ellipse
      if (ellipseData.radiusX === 0 && ellipseData.radiusY === 0) {
        ellipseData.radiusX = 10;
        ellipseData.radiusY = 10;
      }
      isDrawing = false;
      hasEllipse = true;
      showBoundingBox = true;
    }
    drawAll();
    return;
  }

  // If ellipse already exists:
  if (showBoundingBox) {
    const box = getEllipseBoundingBox(ellipseData);
    const handles = getHandlesFromBox(box);
    const hitHandle = findHandleHit(handles, mx, my);

    // console.log('box x: %d, y: %d, width: %d, height: %d',
    //   box.x, box.y, box.width, box.height);
    // console.log('down top-left: %d, %d', handles[0].x, handles[0].y);

    if (hitHandle) {
      // We are dragging a handle -> either shear/resize or rotate
      isDragging = true;
      dragHandle = hitHandle;
      ellipseData.activeHandle = dragHandle;

      // Determine the anchor cross location
      if (editMode === 'rotate') {
        // For rotation, anchor is the ellipse center
        activeAnchor = { x: ellipseData.centerX, y: ellipseData.centerY};
      } else {
        // editMode = 'resize-shear'
        if (dragHandle.role.includes('middle')) {
          // Shear handles => anchor is ellipse center
          activeAnchor = { x: ellipseData.centerX, y: ellipseData.centerY};
        } else {
          // Corner handle => anchor is the opposite corner
          // console.log('ellipse Cx: %d, Cy: %d, Rx: %d, Ry: %d', 
          //   ellipseData.centerX, ellipseData.centerY,
          //   ellipseData.radiusX, ellipseData.radiusY);
          activeAnchor = getOppositeCornerScreenCoord(box, dragHandle.role);
          console.log('down activeAnchor x: %d, y: %d', 
            activeAnchor.x, activeAnchor.y);
        }
      }
      return;
    }

    // If user clicked inside bounding box (but not on a handle),
    // we toggle edit mode (resize-shear <-> rotate).
    if (isPointInBox(mx, my, box)) {
      editMode = (editMode === 'resize-shear') ? 'rotate' : 'resize-shear';
      drawAll();
      return;
    }

    // If click inside ellipse but outside bounding box corners => do nothing
    if (isPointInEllipse(mx, my, ellipseData)) {
      // bounding box is already visible, so no change
    } else {
      // outside ellipse => do nothing
    }
  } else {
    // bounding box is hidden. If user clicks inside ellipse, show bounding box again
    if (isPointInEllipse(mx, my, ellipseData)) {
      showBoundingBox = true;
      editMode = 'resize-shear'; // default
      drawAll();
    }
  }
}

function onMouseMove(e) {
  const { offsetX: mx, offsetY: my } = e;

  if (!hasEllipse && isDrawing) {
    // Updating ellipse radius in real-time
    ellipseData.radiusX = Math.abs(mx - ellipseData.centerX);
    ellipseData.radiusY = Math.abs(my - ellipseData.centerY);
    drawAll();
    return;
  }

  // current ellipse box
  const boxBefore = getEllipseBoundingBox(ellipseData);

  if (hasEllipse && isDragging && dragHandle) {
    // We are dragging a handle
    const dx = mx - lastMousePos.x;
    const dy = my - lastMousePos.y;

    if (editMode === 'resize-shear') {
      if (dragHandle.role.includes('middle')) {
        // Shear
        if (dragHandle.role === 'top-middle' || dragHandle.role === 'bottom-middle') {
          // Shear in X direction
          ellipseData.shearX += dx * 0.01;
        } else {
          // left-middle or right-middle => shear in Y direction
          ellipseData.shearY += dy * 0.01;
        }
      } else {
        // Corner => resize
        const signX = dragHandle.role.includes('left') ? -1 : 1;
        const signY = dragHandle.role.includes('top')  ? -1 : 1;

        ellipseData.radiusX += signX * dx;
        ellipseData.radiusY += signY * dy;

        // Constrain minimum radius
        ellipseData.radiusX = Math.max(5, ellipseData.radiusX);
        ellipseData.radiusY = Math.max(5, ellipseData.radiusY);

        // Calculate new center
        // ellipseData.centerX = activeAnchor.x + signX * ellipseData.radiusX;
        // ellipseData.centerY = activeAnchor.y + signY * ellipseData.radiusY;

        const center = computeEllipseCenterForBoxTopLeft(
          ellipseData.radiusX, ellipseData.radiusY,
          ellipseData.shearX, ellipseData.shearY, ellipseData.rotation,
          activeAnchor.role, activeAnchor);
        ellipseData.centerX = center.centerX;
        ellipseData.centerY = center.centerY;

        // const Msg = '{' + Math.round(ellipseData.centerX) + ',' +
        //   Math.round(ellipseData.centerY) + ',' + ellipseData.radiusX + '}, {' + 
        //   activeAnchor.x + ', ' + activeAnchor.y + '}';
        // myLog(Msg);
        console.log('ellipse center: %d, %d', ellipseData.centerX, ellipseData.centerY);
        console.log('ellipse Rx: %d', ellipseData.radiusX);
        console.log('activeAnchor: %d, %d', activeAnchor.x, activeAnchor.y);

        const boxAfter = getEllipseBoundingBox(ellipseData);
        console.log('boxAfter: {%d,%d}, {%d, %d}', 
          boxAfter.x, boxAfter.y, boxAfter.width, boxAfter.height);

        // moveEllipseBoundingBoxTopLeft(ellipseData, boxAfter.x, boxAfter.y);

        // ellipseData.centerX = 
        //   deltaX > 0 ? ellipseData.centerX - deltaX : ellipseData.centerX + deltaX;
        // ellipseData.centerY = 
        //   deltaY > 0 ? ellipseData.centerX - deltaY : ellipseData.centerX + deltaY; 
      }

    } else if (editMode === 'rotate') {
      // Rotate around ellipse center
      const rotationSpeed = 0.01;
      ellipseData.rotation += dx * rotationSpeed;
    }
    

    lastMousePos.x = mx;
    lastMousePos.y = my;
    drawAll();
  }
}

function onMouseUp(e) {
  isDragging = false;
  dragHandle = null;
  activeAnchor = null;  // stop drawing the cross
  const box = getEllipseBoundingBox(ellipseData);
  const handles = getHandlesFromBox(box);
  console.log('up top-left handle: %d, %d', handles[0].x, handles[0].y);
  console.log('up box center: %d, %d', 
    box.x + box.width / 2, box.y + box.height / 2)
  drawAll();
}

function onContextMenu(e) {
  e.preventDefault();
  // Hide bounding box
  showBoundingBox = false;
  drawAll();
}

/**
 * Compute the opposite corner in the bounding box for a given corner-handle role.
 * E.g. if role='top-left', opposite corner => (box.x+box.width, box.y+box.height)
 */
function getOppositeCornerScreenCoord(box, handleRole) {
  const { x, y, width, height } = box;
  // corners
  if (handleRole === 'top-left') {
    return { x: x + width, y: y + height, role: 'bottom-right' };
  }
  if (handleRole === 'top-right') {
    return { x: x, y: y + height, role: 'bottom-left' };
  }
  if (handleRole === 'bottom-left') {
    return { x: x + width, y: y, role: 'top-right' };
  }
  if (handleRole === 'bottom-right') {
    return { x: x, y: y, role: 'top-left'};
  }
  // If somehow called on mid-side handle, fallback to center
  // (shouldn't happen with the corner-only call).
  return { x: x + width / 2, y: y + height / 2 };
}

// -----------------------------------------------------------
// Drawing
// -----------------------------------------------------------
function drawAll() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // If in the middle of creating the ellipse (two clicks)
  if (!hasEllipse && isDrawing) {
    drawEllipse(ellipseData);
    return;
  }

  // If ellipse is created
  if (hasEllipse) {
    drawEllipse(ellipseData);
  }

  // If bounding box is visible
  if (hasEllipse && showBoundingBox) {
    const box = getEllipseBoundingBox(ellipseData);
    drawBoundingBox(box);

    const handles = getHandlesFromBox(box);
    if (!isDragging) {
      drawHandles(handles);
    }
  }

  // If we have an active anchor cross (while dragging), draw it
  if (activeAnchor) {
    const box = getEllipseBoundingBox(ellipseData);
    const corner = getOppositeCornerScreenCoord(box, 
      ellipseData.activeHandle.role);
    drawAnchorCross(ctx, corner.x, corner.y, 10);
  }
}

/**
 * Draw the ellipse from its parametric points
 */
function drawEllipse(ellipseData) {
  const pts = getEllipsePoints(ellipseData, 60);
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    ctx.lineTo(pts[i].x, pts[i].y);
  }
  ctx.closePath();
  ctx.strokeStyle = 'black';
  ctx.lineWidth = 2;
  ctx.stroke();
}

/**
 * Draw bounding box
 */
function drawBoundingBox(box) {
  ctx.save();
  ctx.strokeStyle = 'blue';
  ctx.lineWidth = 1;
  ctx.strokeRect(box.x, box.y, box.width, box.height);
  ctx.restore();
}

/**
 * Draw the 8 handles. If editMode='rotate', draw half-circles;
 * else draw full circles.
 */
function drawHandles(handles) {
  ctx.save();
  for (let h of handles) {
    ctx.beginPath();
    if (editMode === 'rotate') {
      // half-circle (just to indicate rotation mode visually)
      ctx.strokeStyle = 'green';
      ctx.arc(h.x, h.y, 5, 0, Math.PI, false);
      ctx.stroke();
    } else {
      // resize/shear mode => full circle
      ctx.fillStyle = 'red';
      ctx.arc(h.x, h.y, 5, 0, 2 * Math.PI);
      ctx.fill();
    }
  }
  ctx.restore();
}

// Initial draw
drawAll();

console.log('Script loaded. Ready to draw ellipse.');
