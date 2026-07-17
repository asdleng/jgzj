const assert = require('node:assert/strict');
const test = require('node:test');

const {
  cameraAxisToWorld,
  cameraCenterFromImagePose,
  cameraForwardInWorld,
  cameraUpInWorld,
  mapVectorToSuperSplatViewer,
  pinholeFovDegrees
} = require('./three-dgs-camera-math');

function assertVectorClose(actual, expected, tolerance = 1e-9) {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < actual.length; index += 1) {
    assert.ok(
      Math.abs(actual[index] - expected[index]) <= tolerance,
      `component ${index}: expected ${expected[index]}, got ${actual[index]}`
    );
  }
}

test('identity COLMAP pose preserves camera axes and computes C=-R^T t', () => {
  const qvec = [1, 0, 0, 0];
  assertVectorClose(cameraCenterFromImagePose(qvec, [1, 2, 3]), [-1, -2, -3]);
  assertVectorClose(cameraAxisToWorld(qvec, [1, 0, 0]), [1, 0, 0]);
  assertVectorClose(cameraForwardInWorld(qvec), [0, 0, 1]);
  assertVectorClose(cameraForwardInWorld(qvec, -1), [0, 0, -1]);
  assertVectorClose(cameraUpInWorld(qvec), [0, -1, 0]);
});

const bit0041FirstGroup = {
  camera1: {
    qvec: [0.437660481309, 0.561356089678, -0.538620391555, 0.450800085939],
    tvec: [0.0375929239206, -0.63438532487, -0.925612097845],
    center: [0.7710650010778324, 0.01961582489698225, -0.8158985008144866],
    forward: [0.9775847056230625, 0.005747058708279068, -0.21046491969464584],
    up: [0.21012090847596246, 0.036682753802709474, 0.9769869903917278]
  },
  camera2: {
    qvec: [0.455967301409, 0.566662110371, 0.548832216853, -0.412032851189],
    tvec: [0.0158482239766, -0.73537162616, -0.369320210071],
    center: [-0.1771335311482169, 0.021420632712781707, -0.8034832991049919],
    forward: [-0.9674658923097172, 0.0644853635806388, -0.24464508874129362],
    up: [-0.24625782998625903, -0.01824596442094995, 0.9690325928227638]
  },
  camera3: {
    qvec: [0.641391716436, 0.767213435299, 0.000459065905106, 0.00000651346511365],
    tvec: [-0.264396233791, -0.200137264803, -0.293233140295],
    center: [0.2643691879569319, 0.2533038812023578, -0.24878099798328734],
    forward: [-0.0005783589472813273, 0.9841691110799887, -0.17723292912704783],
    up: [-0.0007127584253084594, 0.177232910691505, 0.9841686782982091]
  },
  camera4: {
    qvec: [0.0176689942106, -0.0166752506518, 0.7710146726, -0.636353767408],
    tvec: [0.292514972487, -0.181148517757, -0.274993352533],
    center: [0.28178180830123717, -0.23472559498721973, -0.2439345541093469],
    forward: [-0.006023056569127188, -0.981865676917136, -0.18948334425911809],
    up: [0.04820118790811338, -0.18955163744232822, 0.9806869134576941]
  }
};

test('BIT-0041 camera centers and optical axes stay in the map frame', () => {
  for (const fixture of Object.values(bit0041FirstGroup)) {
    assertVectorClose(cameraCenterFromImagePose(fixture.qvec, fixture.tvec), fixture.center, 2e-6);
    assertVectorClose(cameraForwardInWorld(fixture.qvec), fixture.forward, 2e-6);
    assertVectorClose(cameraUpInWorld(fixture.qvec), fixture.up, 2e-6);
    assert.ok(Math.abs(cameraForwardInWorld(fixture.qvec).reduce(
      (dot, value, index) => dot + value * cameraUpInWorld(fixture.qvec)[index],
      0
    )) < 2e-6, 'camera forward and up must remain orthogonal');
  }
});

test('BIT-0041 optical axes retain the calibrated front, rear, left and right semantics', () => {
  const directions = Object.fromEntries(
    Object.entries(bit0041FirstGroup).map(([name, fixture]) => [name, cameraForwardInWorld(fixture.qvec)])
  );
  assert.ok(directions.camera1[0] > 0.95, 'camera1 must face vehicle/map forward');
  assert.ok(directions.camera2[0] < -0.95, 'camera2 must face vehicle/map rear');
  assert.ok(directions.camera3[1] > 0.95, 'camera3 must face vehicle/map left');
  assert.ok(directions.camera4[1] < -0.95, 'camera4 must face vehicle/map right');
  for (const direction of Object.values(directions)) {
    assert.ok(direction[2] < -0.17, 'all four cameras should retain their downward pitch');
  }
});

test('map camera poses follow the same Z-180 transform as the SuperSplat entity', () => {
  for (const fixture of Object.values(bit0041FirstGroup)) {
    const viewerCenter = mapVectorToSuperSplatViewer(
      cameraCenterFromImagePose(fixture.qvec, fixture.tvec)
    );
    const viewerForward = mapVectorToSuperSplatViewer(cameraForwardInWorld(fixture.qvec));
    const viewerUp = mapVectorToSuperSplatViewer(cameraUpInWorld(fixture.qvec));

    assertVectorClose(viewerCenter, [-fixture.center[0], -fixture.center[1], fixture.center[2]], 2e-6);
    assertVectorClose(viewerForward, [-fixture.forward[0], -fixture.forward[1], fixture.forward[2]], 2e-6);
    assertVectorClose(viewerUp, [-fixture.up[0], -fixture.up[1], fixture.up[2]], 2e-6);
    assert.ok(Math.abs(viewerForward.reduce(
      (dot, value, index) => dot + value * viewerUp[index],
      0
    )) < 2e-6, 'viewer forward and up must remain orthogonal');
  }
});

test('COLMAP pinhole intrinsics produce separate horizontal and vertical FOV values', () => {
  const fov = pinholeFovDegrees(1920, 1080, 1011.4, 1011.09);
  assert.ok(Math.abs(fov.horizontal - 87.01294916492287) < 1e-9);
  assert.ok(Math.abs(fov.vertical - 56.21130710709573) < 1e-9);
  assert.throws(() => pinholeFovDegrees(1920, 1080, 0, 1000), /positive finite/);
});
