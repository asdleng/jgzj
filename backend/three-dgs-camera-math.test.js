const assert = require('node:assert/strict');
const test = require('node:test');

const {
  cameraAxisToWorld,
  cameraCenterFromImagePose,
  cameraForwardInWorld
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
});

const bit0041FirstGroup = {
  camera1: {
    qvec: [0.437660481309, 0.561356089678, -0.538620391555, 0.450800085939],
    tvec: [0.0375929239206, -0.63438532487, -0.925612097845],
    center: [0.7710650010778324, 0.01961582489698225, -0.8158985008144866],
    forward: [0.9775847056230625, 0.005747058708279068, -0.21046491969464584]
  },
  camera2: {
    qvec: [0.455967301409, 0.566662110371, 0.548832216853, -0.412032851189],
    tvec: [0.0158482239766, -0.73537162616, -0.369320210071],
    center: [-0.1771335311482169, 0.021420632712781707, -0.8034832991049919],
    forward: [-0.9674658923097172, 0.0644853635806388, -0.24464508874129362]
  },
  camera3: {
    qvec: [0.641391716436, 0.767213435299, 0.000459065905106, 0.00000651346511365],
    tvec: [-0.264396233791, -0.200137264803, -0.293233140295],
    center: [0.2643691879569319, 0.2533038812023578, -0.24878099798328734],
    forward: [-0.0005783589472813273, 0.9841691110799887, -0.17723292912704783]
  },
  camera4: {
    qvec: [0.0176689942106, -0.0166752506518, 0.7710146726, -0.636353767408],
    tvec: [0.292514972487, -0.181148517757, -0.274993352533],
    center: [0.28178180830123717, -0.23472559498721973, -0.2439345541093469],
    forward: [-0.006023056569127188, -0.981865676917136, -0.18948334425911809]
  }
};

test('BIT-0041 camera centers and optical axes stay in the map frame', () => {
  for (const fixture of Object.values(bit0041FirstGroup)) {
    assertVectorClose(cameraCenterFromImagePose(fixture.qvec, fixture.tvec), fixture.center, 2e-6);
    assertVectorClose(cameraForwardInWorld(fixture.qvec), fixture.forward, 2e-6);
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
