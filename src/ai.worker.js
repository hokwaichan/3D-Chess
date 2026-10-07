import { findBestMove, LEVELS } from './engine.js';

self.onmessage = ({ data }) => {
  const move = findBestMove(data.fen, LEVELS[data.level]);
  self.postMessage({ id: data.id, move });
};
