const revealItems = [...document.querySelectorAll("[data-reveal]")];
      const io = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              entry.target.classList.add("is-visible");
              io.unobserve(entry.target);
            }
          });
        },
        { threshold: 0.14 }
      );

      revealItems.forEach((el) => io.observe(el));

      const progress = document.getElementById("scroll-progress");
      const parallax = document.querySelector("[data-parallax]");
      const onScroll = () => {
        const doc = document.documentElement;
        const max = doc.scrollHeight - window.innerHeight;
        const ratio = max > 0 ? window.scrollY / max : 0;

        if (progress) {
          progress.style.transform = `scaleX(${Math.min(1, Math.max(0, ratio))})`;
        }

        if (parallax) {
          parallax.style.transform = `translate3d(0, ${window.scrollY * 0.12}px, 0)`;
        }
      };

      window.addEventListener("scroll", onScroll, { passive: true });
      onScroll();

      // Back-to-top button
      const backToTop = document.getElementById("back-to-top");
      if (backToTop) {
        const toggleBackToTop = () => {
          if (window.scrollY > 480) {
            backToTop.hidden = false;
            backToTop.classList.add("is-visible");
          } else {
            backToTop.classList.remove("is-visible");
          }
        };
        window.addEventListener("scroll", toggleBackToTop, { passive: true });
        backToTop.addEventListener("click", () => {
          window.scrollTo({ top: 0, behavior: "smooth" });
        });
        toggleBackToTop();
      }
