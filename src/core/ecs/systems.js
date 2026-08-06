import { query } from 'https://esm.sh/bitecs@0.4.0';
import { Position, Look } from './components.js';
import { vNorm, vCross, vAdd, vScale } from '../utils/math.js';

export function createMovementSystem(world, keys) {
  return function movementSystem(dt) {
    for (const eid of query(world, [Position, Look])) {
      const yaw = Look.yaw[eid],
        pitch = Look.pitch[eid];
      const forward = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
      const worldUp = [0, 1, 0];
      const right = vNorm(vCross(forward, worldUp));
      const up = [0, 1, 0];

      const speed = (keys.has('ShiftLeft') ? 34 : 14) * dt;
      let mv = [0, 0, 0];
      if (keys.has('KeyW')) mv = vAdd(mv, forward);
      if (keys.has('KeyS')) mv = vAdd(mv, vScale(forward, -1));
      if (keys.has('KeyD')) mv = vAdd(mv, right);
      if (keys.has('KeyA')) mv = vAdd(mv, vScale(right, -1));
      if (keys.has('Space')) mv = vAdd(mv, up);
      if (keys.has('ControlLeft')) mv = vAdd(mv, vScale(up, -1));

      const len = Math.hypot(mv[0], mv[1], mv[2]);
      if (len > 0.0001) {
        mv = vScale(mv, speed / len);
        Position.x[eid] += mv[0];
        Position.y[eid] += mv[1];
        Position.z[eid] += mv[2];
      }
    }
  };
}
