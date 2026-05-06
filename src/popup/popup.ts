// Popup script for WorkdayAgent
console.log('WorkdayAgent popup loaded');

const statusEl = document.getElementById('status');

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const currentTab = tabs[0];
  if (!currentTab?.url) {
    if (statusEl) statusEl.textContent = 'No active tab detected.';
    return;
  }

  const isWorkday = currentTab.url.includes('myworkdayjobs.com');
  if (statusEl) {
    statusEl.textContent = isWorkday
      ? '✓ Workday page detected. Ready to assist.'
      : 'Navigate to a Workday application page to use WorkdayAgent.';
  }
});