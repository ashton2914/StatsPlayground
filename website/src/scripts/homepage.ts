const menuToggle = document.querySelector<HTMLButtonElement>("[data-menu-toggle]");
const primaryNavigation = document.querySelector<HTMLElement>("#primary-navigation");

if (menuToggle && primaryNavigation) {
  document.documentElement.dataset.menuReady = "true";

  const setMenuOpen = (open: boolean) => {
    const mobile = !window.matchMedia("(min-width: 760px)").matches;
    menuToggle.setAttribute("aria-expanded", String(open));
    menuToggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    document.documentElement.toggleAttribute("data-menu-open", open);
    document.body.classList.toggle("menu-open", open);
    primaryNavigation.toggleAttribute("hidden", mobile && !open);
    primaryNavigation.querySelectorAll<HTMLAnchorElement>("a").forEach((link) => {
      link.tabIndex = open || !mobile ? 0 : -1;
    });

    const openIcon = menuToggle.querySelector<HTMLElement>('[data-menu-icon="open"]');
    const closeIcon = menuToggle.querySelector<HTMLElement>('[data-menu-icon="close"]');
    openIcon?.toggleAttribute("hidden", open);
    closeIcon?.toggleAttribute("hidden", !open);
  };

  setMenuOpen(false);

  menuToggle.addEventListener("click", () => {
    setMenuOpen(menuToggle.getAttribute("aria-expanded") !== "true");
  });

  primaryNavigation.addEventListener("click", (event) => {
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#"]');
    if (link) setMenuOpen(false);
  });

  window.matchMedia("(min-width: 760px)").addEventListener("change", () => {
    setMenuOpen(false);
  });
}

const revealElements = [...document.querySelectorAll<HTMLElement>("[data-reveal]")];

if (!("IntersectionObserver" in window)) {
  revealElements.forEach((element) => element.setAttribute("data-visible", "true"));
} else {
  document.documentElement.dataset.revealReady = "true";
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.setAttribute("data-visible", "true");
        observer.unobserve(entry.target);
      });
    },
    { rootMargin: "0px 0px -8%", threshold: 0.08 },
  );
  revealElements.forEach((element) => observer.observe(element));
}