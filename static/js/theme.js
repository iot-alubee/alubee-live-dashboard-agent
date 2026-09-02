/** Chart colors + resize helpers (dark dashboard) */
window.getDashboardChartColors = function getDashboardChartColors() {
  return {
    tick: "#bae6fd",
    grid: "rgba(76, 201, 240, 0.1)",
    axisTitle: "#7dd3fc",
    legend: "#e0f2fe",
    legendAlt: "#e8f4ff",
    tooltipBg: "rgba(13, 27, 42, 0.95)",
    tooltipTitle: "#4cc9f0",
    tooltipBody: "#e8f4ff",
    tooltipBorder: "rgba(76, 201, 240, 0.35)",
    datalabel: "#ffffff",
  };
};

let dashboardResizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(dashboardResizeTimer);
  dashboardResizeTimer = setTimeout(() => {
    if (typeof window.resizeLiveChart === "function") window.resizeLiveChart();
    if (typeof window.resizeHistoryCharts === "function") window.resizeHistoryCharts();
  }, 120);
});

window.addEventListener("orientationchange", () => {
  setTimeout(() => {
    if (typeof window.resizeLiveChart === "function") window.resizeLiveChart();
    if (typeof window.resizeHistoryCharts === "function") window.resizeHistoryCharts();
  }, 200);
});
