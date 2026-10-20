// This old endpoint is retired. Data now comes from public/stocks.json, updated weekly by GitHub.
module.exports = (req, res) => {
  res.status(410).json({ error: "This endpoint is retired. Data is read from /stocks.json." });
};
