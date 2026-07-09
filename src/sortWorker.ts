/**
 * デプスソートWorker。
 * メインスレッドからロード時に点座標を一度だけ受け取り(transfer)、
 * 以降はソート要求(z行3成分)に対しインデックス配列を返す。
 */
import { depthSort } from "./depthSort";

interface DataMessage {
  type: "data";
  positions: ArrayBuffer; // Float32Array(count*3)
}
interface SortMessage {
  type: "sort";
  rowZ: [number, number, number];
  epoch: number;
}

let positions: Float32Array | null = null;

self.onmessage = (e: MessageEvent<DataMessage | SortMessage>) => {
  const msg = e.data;
  if (msg.type === "data") {
    positions = new Float32Array(msg.positions);
    return;
  }
  if (msg.type === "sort") {
    if (!positions) return;
    const indices = depthSort(positions, positions.length / 3, msg.rowZ);
    (self as unknown as Worker).postMessage(
      { type: "sorted", indices, epoch: msg.epoch },
      [indices.buffer]
    );
  }
};
