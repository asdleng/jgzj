(() => {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const revealItems = [...document.querySelectorAll("[data-reveal]")];

  function initReveal() {
    if (!revealItems.length) return;
    if (reducedMotion || !("IntersectionObserver" in window)) {
      revealItems.forEach((el) => el.classList.add("is-visible"));
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          io.unobserve(entry.target);
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.12 }
    );

    revealItems.forEach((el) => io.observe(el));
  }

  function initScrollUi() {
    const progress = document.getElementById("scroll-progress");
    const backToTop = document.getElementById("back-to-top");
    const allowParallax = !reducedMotion && window.matchMedia("(min-width: 900px)").matches;
    const parallax = allowParallax ? document.querySelector("[data-parallax]") : null;
    if (!progress && !backToTop && !parallax) return;

    let ticking = false;
    const update = () => {
      ticking = false;
      const scrollY = window.scrollY || document.documentElement.scrollTop || 0;

      if (progress) {
        const doc = document.documentElement;
        const max = doc.scrollHeight - window.innerHeight;
        const ratio = max > 0 ? scrollY / max : 0;
        progress.style.transform = `scaleX(${Math.min(1, Math.max(0, ratio))})`;
      }

      if (parallax) {
        parallax.style.transform = `translate3d(0, ${scrollY * 0.08}px, 0)`;
      }

      if (backToTop) {
        const visible = scrollY > 480;
        backToTop.hidden = false;
        backToTop.classList.toggle("is-visible", visible);
        backToTop.setAttribute("aria-hidden", visible ? "false" : "true");
      }
    };

    const requestUpdate = () => {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(update);
    };

    window.addEventListener("scroll", requestUpdate, { passive: true });
    window.addEventListener("resize", requestUpdate, { passive: true });
    backToTop?.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
    });
    requestUpdate();
  }

  function boot() {
    initReveal();
    initScrollUi();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
