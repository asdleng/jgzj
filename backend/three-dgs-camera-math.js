function normalizeQuaternion(qvec) {
  const values = qvec.map(Number);
  const length = Math.hypot(...values);
  if (!Number.isFinite(length) || length < 1e-12) {
    throw new TypeError('COLMAP qvec must be a finite non-zero quaternion');
  }
  return values.map((value) => value / length);
}

function qvecToRotmat(qvec) {
  const [qw, qx, qy, qz] = normalizeQuaternion(qvec);
  return [
    [1 - 2 * qy * qy - 2 * qz * qz, 2 * qx * qy - 2 * qz * qw, 2 * qx * qz + 2 * qy * qw],
    [2 * qx * qy + 2 * qz * qw, 1 - 2 * qx * qx - 2 * qz * qz, 2 * qy * qz - 2 * qx * qw],
    [2 * qx * qz - 2 * qy * qw, 2 * qy * qz + 2 * qx * qw, 1 - 2 * qx * qx - 2 * qy * qy]
  ];
}

function cameraAxisToWorld(qvec, cameraAxis) {
  if (!Array.isArray(cameraAxis) || cameraAxis.length !== 3) {
    throw new TypeError('camera axis must contain three values');
  }
  const axis = cameraAxis.map(Number);
  if (!axis.every(Number.isFinite)) {
    throw new TypeError('camera axis must be finite');
  }
  const rotation = qvecToRotmat(qvec);

  // COLMAP stores world-to-camera R. Camera vectors return to map/world through R^T.
  return [
    rotation[0][0] * axis[0] + rotation[1][0] * axis[1] + rotation[2][0] * axis[2],
    rotation[0][1] * axis[0] + rotation[1][1] * axis[1] + rotation[2][1] * axis[2],
    rotation[0][2] * axis[0] + rotation[1][2] * axis[1] + rotation[2][2] * axis[2]
  ];
}

function normalizeVector(values) {
  const length = Math.hypot(...values);
  if (!Number.isFinite(length) || length < 1e-12) {
    throw new TypeError('camera vector must be finite and non-zero');
  }
  return values.map((value) => value / length);
}

function cameraCenterFromImagePose(qvec, tvec) {
  if (!Array.isArray(tvec) || tvec.length !== 3 || !tvec.map(Number).every(Number.isFinite)) {
    throw new TypeError('COLMAP tvec must contain three finite values');
  }
  const rotation = qvecToRotmat(qvec);
  const translation = tvec.map(Number);
  return [
    -(rotation[0][0] * translation[0] + rotation[1][0] * translation[1] + rotation[2][0] * translation[2]),
    -(rotation[0][1] * translation[0] + rotation[1][1] * translation[1] + rotation[2][1] * translation[2]),
    -(rotation[0][2] * translation[0] + rotation[1][2] * translation[1] + rotation[2][2] * translation[2])
  ];
}

function cameraForwardInWorld(qvec, sign = 1) {
  const normalizedSign = Number(sign) >= 0 ? 1 : -1;
  return normalizeVector(cameraAxisToWorld(qvec, [0, 0, normalizedSign]));
}

module.exports = {
  cameraAxisToWorld,
  cameraCenterFromImagePose,
  cameraForwardInWorld,
  qvecToRotmat
};
