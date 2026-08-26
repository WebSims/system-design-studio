/* @ds-bundle: {"format":3,"namespace":"HEMADesignSystem_0d1b44","components":[],"sourceHashes":{"ui_kits/app/AppChrome.jsx":"6f1919f1988a","ui_kits/app/AppIcon.jsx":"f12bc16b43e9","ui_kits/app/AppScreens.jsx":"03706b163747","ui_kits/app/app.jsx":"4f73a4cb0551","ui_kits/app/data.js":"77d0b0da350e","ui_kits/app/ios-frame.jsx":"d67eb3ffe562","ui_kits/web/CategoryTile.jsx":"14bae96a9d28","ui_kits/web/Footer.jsx":"d9004db87615","ui_kits/web/Header.jsx":"fb37c52a06c4","ui_kits/web/Hero.jsx":"0e8f245b3146","ui_kits/web/HomeSections.jsx":"3f3431845e44","ui_kits/web/Icon.jsx":"b4cba1c803c8","ui_kits/web/PDPApp.jsx":"0188b79d32e1","ui_kits/web/PDPBuyRail.jsx":"68bb3dad1a84","ui_kits/web/PDPGallery.jsx":"0cd8475d27d2","ui_kits/web/PDPSections.jsx":"d75f14718248","ui_kits/web/ProductCard.jsx":"8e8713773c61","ui_kits/web/Screens.jsx":"3459928171a1","ui_kits/web/Toast.jsx":"91327b3236ae","ui_kits/web/app.jsx":"27a584b6c740","ui_kits/web/data.js":"3e3626b3b4f0"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.HEMADesignSystem_0d1b44 = window.HEMADesignSystem_0d1b44 || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// ui_kits/app/AppChrome.jsx
try { (() => {
// AppChrome.jsx — Header bar, tab bar, generic list components for the app UI kit.

// ---- HEADER ---------------------------------------------------------------
const AppHeader = ({
  title,
  leading,
  trailing,
  transparent = false,
  onBack
}) => /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    alignItems: 'center',
    padding: '8px 12px',
    height: 52,
    gap: 8,
    background: transparent ? 'transparent' : '#fff',
    borderBottom: transparent ? 'none' : '1px solid var(--border-1)',
    position: 'relative',
    zIndex: 2
  }
}, onBack ? /*#__PURE__*/React.createElement("button", {
  onClick: onBack,
  style: {
    width: 36,
    height: 36,
    border: 'none',
    background: 'transparent',
    borderRadius: 999,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer'
  }
}, /*#__PURE__*/React.createElement(AppIcon, {
  name: "arrow-left",
  size: 22
})) : leading || /*#__PURE__*/React.createElement("div", {
  style: {
    width: 36
  }
}), /*#__PURE__*/React.createElement("div", {
  style: {
    flex: 1,
    textAlign: 'center',
    fontSize: 16,
    fontWeight: 700,
    textTransform: 'lowercase'
  }
}, title), trailing || /*#__PURE__*/React.createElement("div", {
  style: {
    width: 36
  }
}));

// ---- TAB BAR --------------------------------------------------------------
const TABS = [{
  id: 'home',
  label: 'home',
  ic: 'home'
}, {
  id: 'browse',
  label: 'shop',
  ic: 'search'
}, {
  id: 'scan',
  label: 'scan',
  ic: 'scan'
}, {
  id: 'bag',
  label: 'mandje',
  ic: 'bag'
}, {
  id: 'account',
  label: 'mij',
  ic: 'user'
}];
const AppTabBar = ({
  active,
  onTab,
  bagCount = 0
}) => /*#__PURE__*/React.createElement("div", {
  style: {
    height: 76,
    background: '#fff',
    borderTop: '1px solid var(--border-1)',
    display: 'grid',
    gridTemplateColumns: 'repeat(5, 1fr)',
    paddingBottom: 6,
    position: 'relative',
    zIndex: 2
  }
}, TABS.map(t => {
  const isActive = active === t.id;
  return /*#__PURE__*/React.createElement("button", {
    key: t.id,
    onClick: () => onTab(t.id),
    style: {
      background: 'transparent',
      border: 'none',
      cursor: 'pointer',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 3,
      color: isActive ? 'var(--hema-red)' : 'var(--fg-3)',
      position: 'relative',
      fontFamily: 'inherit'
    }
  }, /*#__PURE__*/React.createElement(AppIcon, {
    name: t.ic,
    size: 24
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10.5,
      fontWeight: isActive ? 700 : 500,
      textTransform: 'lowercase'
    }
  }, t.label), t.id === 'bag' && bagCount > 0 && /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      top: 6,
      right: 'calc(50% - 18px)',
      background: 'var(--hema-red)',
      color: '#fff',
      fontSize: 10,
      fontWeight: 700,
      minWidth: 18,
      height: 18,
      borderRadius: 999,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '0 4px'
    }
  }, bagCount));
}));

// ---- LIST ROW -------------------------------------------------------------
const ListRow = ({
  icon,
  title,
  sub,
  trailing,
  onClick
}) => /*#__PURE__*/React.createElement("button", {
  onClick: onClick,
  style: {
    width: '100%',
    textAlign: 'left',
    background: '#fff',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    padding: '14px 16px',
    borderBottom: '1px solid var(--border-1)',
    fontFamily: 'inherit'
  }
}, icon && /*#__PURE__*/React.createElement("div", {
  style: {
    width: 36,
    height: 36,
    borderRadius: 999,
    background: 'var(--bg-subtle)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--hema-red)',
    flex: '0 0 auto'
  }
}, /*#__PURE__*/React.createElement(AppIcon, {
  name: icon,
  size: 18
})), /*#__PURE__*/React.createElement("div", {
  style: {
    flex: 1,
    minWidth: 0
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: 15,
    fontWeight: 600
  }
}, title), sub && /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: 12,
    color: 'var(--fg-3)',
    marginTop: 1
  }
}, sub)), trailing || /*#__PURE__*/React.createElement(AppIcon, {
  name: "chevron-right",
  size: 18,
  color: "var(--fg-3)"
}));

// ---- COMPACT PRODUCT TILE -------------------------------------------------
const placeholder = color => `data:image/svg+xml;utf8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="#f5f3ee"/>
  <rect x="20" y="20" width="60" height="60" rx="6" fill="${color}"/>
</svg>`)}`;
const AppProductCard = ({
  p,
  onClick
}) => /*#__PURE__*/React.createElement("button", {
  onClick: () => onClick && onClick(p),
  style: {
    background: '#fff',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    textAlign: 'left',
    padding: 0,
    fontFamily: 'inherit'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    position: 'relative',
    aspectRatio: '1/1',
    background: 'var(--bg-subtle)',
    borderRadius: 8,
    overflow: 'hidden'
  }
}, /*#__PURE__*/React.createElement("img", {
  src: placeholder(p.color),
  alt: p.name,
  style: {
    width: '100%',
    height: '100%'
  }
}), p.badge && /*#__PURE__*/React.createElement("span", {
  style: {
    position: 'absolute',
    top: 6,
    left: 6,
    background: p.badge.startsWith('-') ? 'var(--label-yellow)' : 'var(--hema-red)',
    color: p.badge.startsWith('-') ? '#14100c' : '#fff',
    fontSize: 10,
    fontWeight: 700,
    padding: '2px 7px',
    borderRadius: 999
  }
}, p.badge)), /*#__PURE__*/React.createElement("div", {
  style: {
    paddingTop: 6
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: 12,
    color: 'var(--fg-1)',
    lineHeight: 1.25,
    marginBottom: 2
  }
}, p.name), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 5
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    fontSize: 14,
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
    color: p.was ? 'var(--hema-red)' : 'var(--fg-1)'
  }
}, "\u20AC\xA0", p.price), p.was && /*#__PURE__*/React.createElement("span", {
  style: {
    fontSize: 11,
    color: 'var(--fg-3)',
    textDecoration: 'line-through'
  }
}, "\u20AC\xA0", p.was))));
window.AppHeader = AppHeader;
window.AppTabBar = AppTabBar;
window.AppListRow = ListRow;
window.AppProductCard = AppProductCard;
window.AppPlaceholder = placeholder;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app/AppChrome.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app/AppIcon.jsx
try { (() => {
// AppIcon.jsx — same 24px line set as the web kit, but inlined.
const _STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
};
const AppIcon = ({
  name,
  size = 22,
  color
}) => {
  const props = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    style: {
      color,
      flex: '0 0 auto',
      display: 'block'
    },
    ..._STROKE
  };
  switch (name) {
    case 'home':
      return /*#__PURE__*/React.createElement("svg", props, /*#__PURE__*/React.createElement("path", {
        d: "M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1Z"
      }));
    case 'search':
      return /*#__PURE__*/React.createElement("svg", props, /*#__PURE__*/React.createElement("circle", {
        cx: "11",
        cy: "11",
        r: "7"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M21 21l-4.3-4.3"
      }));
    case 'scan':
      return /*#__PURE__*/React.createElement("svg", props, /*#__PURE__*/React.createElement("path", {
        d: "M3 7V4a1 1 0 0 1 1-1h3M3 17v3a1 1 0 0 0 1 1h3M17 3h3a1 1 0 0 1 1 1v3M17 21h3a1 1 0 0 0 1-1v-3"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M7 12h10"
      }));
    case 'bag':
      return /*#__PURE__*/React.createElement("svg", props, /*#__PURE__*/React.createElement("path", {
        d: "M3 7h18l-2 12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L3 7Z"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M8 7V5a4 4 0 0 1 8 0v2"
      }));
    case 'user':
      return /*#__PURE__*/React.createElement("svg", props, /*#__PURE__*/React.createElement("path", {
        d: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "7",
        r: "4"
      }));
    case 'heart':
      return /*#__PURE__*/React.createElement("svg", props, /*#__PURE__*/React.createElement("path", {
        d: "M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z"
      }));
    case 'arrow-left':
      return /*#__PURE__*/React.createElement("svg", props, /*#__PURE__*/React.createElement("path", {
        d: "M19 12H5M12 19l-7-7 7-7"
      }));
    case 'arrow-right':
      return /*#__PURE__*/React.createElement("svg", props, /*#__PURE__*/React.createElement("path", {
        d: "M5 12h14M12 5l7 7-7 7"
      }));
    case 'chevron-right':
      return /*#__PURE__*/React.createElement("svg", props, /*#__PURE__*/React.createElement("path", {
        d: "m9 6 6 6-6 6"
      }));
    case 'menu':
      return /*#__PURE__*/React.createElement("svg", props, /*#__PURE__*/React.createElement("path", {
        d: "M3 6h18M3 12h18M3 18h18"
      }));
    case 'close':
      return /*#__PURE__*/React.createElement("svg", props, /*#__PURE__*/React.createElement("path", {
        d: "M18 6 6 18M6 6l12 12"
      }));
    case 'plus':
      return /*#__PURE__*/React.createElement("svg", props, /*#__PURE__*/React.createElement("path", {
        d: "M12 5v14M5 12h14"
      }));
    case 'minus':
      return /*#__PURE__*/React.createElement("svg", props, /*#__PURE__*/React.createElement("path", {
        d: "M5 12h14"
      }));
    case 'pin':
      return /*#__PURE__*/React.createElement("svg", props, /*#__PURE__*/React.createElement("path", {
        d: "M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0Z"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "10",
        r: "3"
      }));
    case 'truck':
      return /*#__PURE__*/React.createElement("svg", props, /*#__PURE__*/React.createElement("rect", {
        x: "1",
        y: "3",
        width: "15",
        height: "13",
        rx: "2"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M16 8h4l3 3v5h-7"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "6",
        cy: "19",
        r: "2"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "18",
        cy: "19",
        r: "2"
      }));
    case 'gift':
      return /*#__PURE__*/React.createElement("svg", props, /*#__PURE__*/React.createElement("polyline", {
        points: "20 12 20 22 4 22 4 12"
      }), /*#__PURE__*/React.createElement("rect", {
        x: "2",
        y: "7",
        width: "20",
        height: "5"
      }), /*#__PURE__*/React.createElement("line", {
        x1: "12",
        y1: "22",
        x2: "12",
        y2: "7"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"
      }));
    case 'star':
      return /*#__PURE__*/React.createElement("svg", props, /*#__PURE__*/React.createElement("path", {
        d: "m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1L12 2Z"
      }));
    case 'package':
      return /*#__PURE__*/React.createElement("svg", props, /*#__PURE__*/React.createElement("path", {
        d: "M16.5 9.4 7.5 4.21"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"
      }), /*#__PURE__*/React.createElement("path", {
        d: "m3.27 6.96 8.73 5.05 8.73-5.05"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M12 22V12"
      }));
    case 'settings':
      return /*#__PURE__*/React.createElement("svg", props, /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "12",
        r: "3"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V21a2 2 0 1 1-4 0v-.08A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.04H3a2 2 0 1 1 0-4h.08A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.08a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9c.36.16.85.64 1 1h1a2 2 0 1 1 0 4h-.08a1.7 1.7 0 0 0-1.56 1Z"
      }));
    default:
      return null;
  }
};
window.AppIcon = AppIcon;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app/AppIcon.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app/AppScreens.jsx
try { (() => {
// AppScreens.jsx — Home, Browse, Product, Bag, Account.

const {
  PRODUCTS: APP_PRODUCTS,
  CATEGORIES: APP_CATEGORIES
} = window.HEMA_DATA;

// ──────────────────────────────────────────────────────────────────
// HOME
// ──────────────────────────────────────────────────────────────────
const AppHome = ({
  onNav
}) => /*#__PURE__*/React.createElement("div", {
  style: {
    paddingBottom: 24
  }
}, /*#__PURE__*/React.createElement(AppHeader, {
  leading: /*#__PURE__*/React.createElement("img", {
    src: "../../assets/logo.svg",
    alt: "hema",
    style: {
      width: 32,
      height: 32,
      marginLeft: 4
    }
  }),
  title: "",
  trailing: /*#__PURE__*/React.createElement("button", {
    style: {
      width: 36,
      height: 36,
      border: 'none',
      background: 'transparent',
      borderRadius: 999,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement(AppIcon, {
    name: "heart",
    size: 22
  }))
}), /*#__PURE__*/React.createElement("div", {
  style: {
    padding: '14px 16px 8px'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: 13,
    color: 'var(--fg-3)'
  }
}, "goedemorgen,"), /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: 26,
    fontWeight: 700,
    letterSpacing: '-0.01em',
    textTransform: 'lowercase',
    lineHeight: 1.1
  }
}, "wat zoek je vandaag?")), /*#__PURE__*/React.createElement("button", {
  onClick: () => onNav('browse'),
  style: {
    margin: '0 16px',
    height: 44,
    padding: '0 16px',
    background: 'var(--bg-subtle)',
    borderRadius: 999,
    border: 'none',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: 'calc(100% - 32px)',
    color: 'var(--fg-3)',
    fontSize: 14,
    fontFamily: 'inherit',
    cursor: 'pointer'
  }
}, /*#__PURE__*/React.createElement(AppIcon, {
  name: "search",
  size: 18,
  color: "var(--fg-2)"
}), "waar ben je naar op zoek?"), /*#__PURE__*/React.createElement("div", {
  style: {
    margin: '18px 16px 0',
    background: '#ed2923',
    color: '#fff',
    borderRadius: 14,
    padding: 18,
    display: 'flex',
    alignItems: 'center',
    gap: 14
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    flex: 1
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    opacity: .85,
    marginBottom: 4
  }
}, "deze week"), /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: 22,
    fontWeight: 700,
    lineHeight: 1.05,
    letterSpacing: '-0.01em',
    textTransform: 'lowercase'
  }
}, "2 + 1 gratis op alle theelichtjes"), /*#__PURE__*/React.createElement("button", {
  onClick: () => onNav('browse'),
  className: "btn btn--dark btn--sm",
  style: {
    marginTop: 10,
    background: '#14100c',
    color: '#fff',
    border: 'none',
    borderRadius: 999,
    padding: '6px 14px',
    fontFamily: 'inherit',
    fontWeight: 600
  }
}, "shop nu")), /*#__PURE__*/React.createElement("div", {
  style: {
    width: 84,
    height: 84,
    background: '#fff',
    borderRadius: 12,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: '0 0 auto'
  }
}, /*#__PURE__*/React.createElement("svg", {
  viewBox: "0 0 40 40",
  style: {
    width: 56,
    height: 56
  }
}, /*#__PURE__*/React.createElement("ellipse", {
  cx: "20",
  cy: "30",
  rx: "11",
  ry: "3",
  fill: "#f5c518",
  opacity: ".5"
}), /*#__PURE__*/React.createElement("path", {
  d: "M20 8 Q24 14 24 20 Q24 28 20 30 Q16 28 16 20 Q16 14 20 8 Z",
  fill: "#f08d2c"
}), /*#__PURE__*/React.createElement("path", {
  d: "M20 10 Q21 14 21 18",
  stroke: "#fff",
  strokeWidth: "1.5",
  fill: "none",
  strokeLinecap: "round"
})))), /*#__PURE__*/React.createElement("div", {
  style: {
    padding: '24px 0 8px'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    padding: '0 16px',
    fontSize: 18,
    fontWeight: 700,
    textTransform: 'lowercase',
    letterSpacing: '-0.01em',
    marginBottom: 12
  }
}, "shop op categorie"), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    gap: 10,
    overflowX: 'auto',
    padding: '0 16px',
    scrollbarWidth: 'none'
  }
}, APP_CATEGORIES.map(c => /*#__PURE__*/React.createElement("button", {
  key: c.id,
  onClick: () => onNav('browse', c.id),
  style: {
    flex: '0 0 84px',
    height: 100,
    borderRadius: 12,
    border: 'none',
    background: c.color,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'flex-end',
    padding: 10,
    color: c.color === '#f5c518' ? '#14100c' : '#fff',
    fontFamily: 'inherit',
    fontWeight: 700,
    fontSize: 12,
    textTransform: 'lowercase',
    textAlign: 'left'
  }
}, c.label)))), /*#__PURE__*/React.createElement("div", {
  style: {
    padding: '18px 16px 8px'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 10
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    fontSize: 18,
    fontWeight: 700,
    textTransform: 'lowercase',
    letterSpacing: '-0.01em'
  }
}, "aanbiedingen"), /*#__PURE__*/React.createElement("button", {
  onClick: () => onNav('browse'),
  style: {
    background: 'transparent',
    border: 'none',
    color: 'var(--hema-red)',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit'
  }
}, "alles bekijken \u2192")), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 12
  }
}, APP_PRODUCTS.filter(p => p.was).slice(0, 4).map(p => /*#__PURE__*/React.createElement(AppProductCard, {
  key: p.id,
  p: p,
  onClick: () => onNav('product', p.id)
})))), /*#__PURE__*/React.createElement("div", {
  style: {
    padding: '18px 16px 8px'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: 18,
    fontWeight: 700,
    textTransform: 'lowercase',
    letterSpacing: '-0.01em',
    marginBottom: 10
  }
}, "misschien ook iets voor jou"), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 12
  }
}, APP_PRODUCTS.slice(0, 4).map(p => /*#__PURE__*/React.createElement(AppProductCard, {
  key: p.id,
  p: p,
  onClick: () => onNav('product', p.id)
})))));

// ──────────────────────────────────────────────────────────────────
// BROWSE
// ──────────────────────────────────────────────────────────────────
const AppBrowse = ({
  onNav,
  catFilter
}) => {
  const [filter, setFilter] = React.useState(catFilter || 'alles');
  const items = filter === 'alles' ? APP_PRODUCTS : APP_PRODUCTS.filter(p => p.cat === filter);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      paddingBottom: 24
    }
  }, /*#__PURE__*/React.createElement(AppHeader, {
    title: "shop"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '12px 16px 0'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: 44,
      padding: '0 16px',
      background: 'var(--bg-subtle)',
      borderRadius: 999,
      display: 'flex',
      alignItems: 'center',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement(AppIcon, {
    name: "search",
    size: 18,
    color: "var(--fg-2)"
  }), /*#__PURE__*/React.createElement("input", {
    placeholder: "zoek in alles",
    style: {
      flex: 1,
      border: 'none',
      outline: 'none',
      background: 'transparent',
      fontFamily: 'inherit',
      fontSize: 14
    }
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      overflowX: 'auto',
      padding: '14px 16px',
      scrollbarWidth: 'none'
    }
  }, ['alles', ...APP_CATEGORIES.map(c => c.id)].map(c => /*#__PURE__*/React.createElement("button", {
    key: c,
    onClick: () => setFilter(c),
    style: {
      flex: '0 0 auto',
      padding: '8px 14px',
      borderRadius: 999,
      border: filter === c ? '1px solid #14100c' : '1px solid var(--border-1)',
      background: filter === c ? '#14100c' : '#fff',
      color: filter === c ? '#fff' : 'var(--fg-1)',
      fontFamily: 'inherit',
      fontSize: 13,
      fontWeight: 600,
      textTransform: 'lowercase',
      cursor: 'pointer'
    }
  }, c))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '0 16px 16px',
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 12
    }
  }, items.map(p => /*#__PURE__*/React.createElement(AppProductCard, {
    key: p.id,
    p: p,
    onClick: () => onNav('product', p.id)
  }))));
};

// ──────────────────────────────────────────────────────────────────
// PRODUCT
// ──────────────────────────────────────────────────────────────────
const AppProduct = ({
  id,
  onAdd,
  onBack
}) => {
  const p = APP_PRODUCTS.find(x => x.id === id) || APP_PRODUCTS[0];
  const [size, setSize] = React.useState('m');
  return /*#__PURE__*/React.createElement("div", {
    style: {
      paddingBottom: 90 /* leave room for sticky CTA */
    }
  }, /*#__PURE__*/React.createElement(AppHeader, {
    title: "",
    onBack: onBack,
    trailing: /*#__PURE__*/React.createElement("button", {
      style: {
        width: 36,
        height: 36,
        border: 'none',
        background: 'transparent',
        borderRadius: 999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }
    }, /*#__PURE__*/React.createElement(AppIcon, {
      name: "heart",
      size: 22
    }))
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      aspectRatio: '1/1',
      background: 'var(--bg-subtle)'
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: window.AppPlaceholder(p.color),
    alt: p.name,
    style: {
      width: '100%',
      height: '100%'
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6,
      justifyContent: 'center',
      padding: '10px 0 4px'
    }
  }, [0, 1, 2, 3].map(i => /*#__PURE__*/React.createElement("span", {
    key: i,
    style: {
      width: 6,
      height: 6,
      borderRadius: 999,
      background: i === 0 ? 'var(--fg-1)' : 'var(--border-2)'
    }
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '12px 16px 0'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: 'var(--fg-3)',
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
      fontWeight: 600,
      marginBottom: 4
    }
  }, p.cat), /*#__PURE__*/React.createElement("h1", {
    style: {
      fontSize: 22,
      fontWeight: 700,
      lineHeight: 1.15,
      letterSpacing: '-0.01em',
      textTransform: 'lowercase',
      margin: '0 0 6px'
    }
  }, p.name), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      marginBottom: 14
    }
  }, [1, 2, 3, 4, 5].map(s => /*#__PURE__*/React.createElement(AppIcon, {
    key: s,
    name: "star",
    size: 14,
    color: s <= 4 ? '#f5c518' : '#c9c4ba'
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: 'var(--fg-3)'
    }
  }, "4,3 \xB7 128")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 8,
      marginBottom: 18
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 28,
      fontWeight: 700,
      fontVariantNumeric: 'tabular-nums',
      color: p.was ? 'var(--hema-red)' : 'var(--fg-1)'
    }
  }, "\u20AC\xA0", p.price), p.was && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 15,
      color: 'var(--fg-3)',
      textDecoration: 'line-through'
    }
  }, "\u20AC\xA0", p.was)), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 18
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      fontWeight: 700,
      marginBottom: 8
    }
  }, "maat"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8
    }
  }, ['s', 'm', 'l', 'xl'].map(s => /*#__PURE__*/React.createElement("button", {
    key: s,
    onClick: () => setSize(s),
    style: {
      flex: 1,
      height: 44,
      borderRadius: 8,
      cursor: 'pointer',
      background: '#fff',
      fontFamily: 'inherit',
      fontSize: 14,
      fontWeight: 700,
      border: size === s ? '2px solid var(--fg-1)' : '1px solid var(--border-1)',
      textTransform: 'uppercase'
    }
  }, s)))), /*#__PURE__*/React.createElement("ul", {
    style: {
      listStyle: 'none',
      padding: 0,
      margin: '0 0 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("li", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      fontSize: 13,
      color: 'var(--fg-2)'
    }
  }, /*#__PURE__*/React.createElement(AppIcon, {
    name: "truck",
    size: 16,
    color: "var(--hema-red)"
  }), " morgen in huis \xB7 bestel voor 22:00"), /*#__PURE__*/React.createElement("li", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      fontSize: 13,
      color: 'var(--fg-2)'
    }
  }, /*#__PURE__*/React.createElement(AppIcon, {
    name: "pin",
    size: 16,
    color: "var(--hema-red)"
  }), " nu in 12 winkels in de buurt"))), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      background: '#fff',
      borderTop: '1px solid var(--border-1)',
      padding: '10px 16px 14px',
      display: 'flex',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn--primary",
    style: {
      flex: 1,
      height: 48
    },
    onClick: () => onAdd(p)
  }, /*#__PURE__*/React.createElement(AppIcon, {
    name: "bag",
    size: 18
  }), " in mandje \xB7 \u20AC\xA0", p.price)));
};

// ──────────────────────────────────────────────────────────────────
// BAG
// ──────────────────────────────────────────────────────────────────
const AppBag = ({
  cart,
  setCart,
  onNav
}) => {
  const items = cart.map(c => ({
    ...APP_PRODUCTS.find(p => p.id === c.id),
    qty: c.qty
  }));
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  const shipping = subtotal >= 30 || subtotal === 0 ? 0 : 4;
  const total = subtotal + shipping;
  const update = (id, d) => setCart(c => c.map(i => i.id === id ? {
    ...i,
    qty: Math.max(0, i.qty + d)
  } : i).filter(i => i.qty > 0));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      paddingBottom: 24
    }
  }, /*#__PURE__*/React.createElement(AppHeader, {
    title: "mijn mandje"
  }), items.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 28,
      textAlign: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 64,
      height: 64,
      borderRadius: 999,
      background: 'var(--bg-subtle)',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 12,
      color: 'var(--fg-3)'
    }
  }, /*#__PURE__*/React.createElement(AppIcon, {
    name: "bag",
    size: 28
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 17,
      fontWeight: 700,
      marginBottom: 4
    }
  }, "je mandje is leeg"), /*#__PURE__*/React.createElement("div", {
    style: {
      color: 'var(--fg-3)',
      fontSize: 14,
      marginBottom: 16
    }
  }, "kijk gerust rond, we hebben genoeg te bieden"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn--primary",
    onClick: () => onNav('home')
  }, "verder winkelen")) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("ul", {
    style: {
      listStyle: 'none',
      margin: 0,
      padding: '8px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: 10
    }
  }, items.map(i => /*#__PURE__*/React.createElement("li", {
    key: i.id,
    style: {
      background: '#fff',
      borderRadius: 10,
      border: '1px solid var(--border-1)',
      padding: 10,
      display: 'grid',
      gridTemplateColumns: '64px 1fr auto',
      gap: 10,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: window.AppPlaceholder(i.color),
    alt: i.name,
    style: {
      width: 64,
      height: 64,
      borderRadius: 6
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      fontWeight: 600,
      lineHeight: 1.25
    }
  }, i.name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: 'var(--fg-3)'
    }
  }, i.cat), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 6,
      display: 'flex',
      alignItems: 'center',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => update(i.id, -1),
    style: {
      width: 26,
      height: 26,
      borderRadius: 999,
      border: '1px solid var(--border-1)',
      background: '#fff',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      cursor: 'pointer'
    }
  }, /*#__PURE__*/React.createElement(AppIcon, {
    name: "minus",
    size: 12
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      minWidth: 18,
      textAlign: 'center',
      fontSize: 13,
      fontWeight: 700
    }
  }, i.qty), /*#__PURE__*/React.createElement("button", {
    onClick: () => update(i.id, 1),
    style: {
      width: 26,
      height: 26,
      borderRadius: 999,
      border: '1px solid var(--border-1)',
      background: '#fff',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      cursor: 'pointer'
    }
  }, /*#__PURE__*/React.createElement(AppIcon, {
    name: "plus",
    size: 12
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 15,
      fontWeight: 700,
      fontVariantNumeric: 'tabular-nums'
    }
  }, "\u20AC\xA0", i.price * i.qty)))), /*#__PURE__*/React.createElement("div", {
    style: {
      margin: '14px 16px',
      padding: 14,
      background: 'var(--bg-subtle)',
      borderRadius: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      fontSize: 14,
      marginBottom: 6
    }
  }, /*#__PURE__*/React.createElement("span", null, "subtotaal"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontVariantNumeric: 'tabular-nums'
    }
  }, "\u20AC\xA0", subtotal)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      fontSize: 14,
      marginBottom: 6
    }
  }, /*#__PURE__*/React.createElement("span", null, "verzending"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontVariantNumeric: 'tabular-nums',
      color: shipping === 0 ? 'var(--success)' : 'var(--fg-1)'
    }
  }, shipping === 0 ? 'gratis' : `€ ${shipping}`)), subtotal > 0 && subtotal < 30 && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: 'var(--fg-3)',
      marginBottom: 8
    }
  }, "nog \u20AC ", 30 - subtotal, " voor gratis verzending"), /*#__PURE__*/React.createElement("hr", {
    style: {
      border: 'none',
      borderTop: '1px solid var(--border-1)',
      margin: '8px 0'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      fontWeight: 700,
      fontSize: 16
    }
  }, /*#__PURE__*/React.createElement("span", null, "totaal"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontVariantNumeric: 'tabular-nums'
    }
  }, "\u20AC\xA0", total)), /*#__PURE__*/React.createElement("button", {
    className: "btn btn--primary",
    style: {
      width: '100%',
      marginTop: 12
    }
  }, "afrekenen"))));
};

// ──────────────────────────────────────────────────────────────────
// SCAN
// ──────────────────────────────────────────────────────────────────
const AppScan = () => /*#__PURE__*/React.createElement("div", {
  style: {
    flex: 1,
    background: '#14100c',
    color: '#fff',
    display: 'flex',
    flexDirection: 'column'
  }
}, /*#__PURE__*/React.createElement(AppHeader, {
  title: "scan & save",
  transparent: true,
  leading: /*#__PURE__*/React.createElement("div", {
    style: {
      width: 36
    }
  }),
  trailing: /*#__PURE__*/React.createElement("button", {
    style: {
      width: 36,
      height: 36,
      border: 'none',
      background: 'transparent',
      color: '#fff'
    }
  }, /*#__PURE__*/React.createElement(AppIcon, {
    name: "close",
    size: 22
  }))
}), /*#__PURE__*/React.createElement("div", {
  style: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    width: 240,
    height: 240,
    border: '2px solid rgba(255,255,255,.18)',
    borderRadius: 24,
    position: 'relative'
  }
}, [['tl', 'top:-2px;left:-2px;border-top:3px solid #ed2923;border-left:3px solid #ed2923;border-radius:24px 0 0 0'], ['tr', 'top:-2px;right:-2px;border-top:3px solid #ed2923;border-right:3px solid #ed2923;border-radius:0 24px 0 0'], ['bl', 'bottom:-2px;left:-2px;border-bottom:3px solid #ed2923;border-left:3px solid #ed2923;border-radius:0 0 0 24px'], ['br', 'bottom:-2px;right:-2px;border-bottom:3px solid #ed2923;border-right:3px solid #ed2923;border-radius:0 0 24px 0']].map(([k, css]) => /*#__PURE__*/React.createElement("span", {
  key: k,
  style: {
    position: 'absolute',
    width: 44,
    height: 44,
    ...Object.fromEntries(css.split(';').map(p => p.split(':').map(s => s.trim())).map(([k, v]) => [k.replace(/-./g, m => m[1].toUpperCase()), v]))
  }
})), /*#__PURE__*/React.createElement("div", {
  style: {
    position: 'absolute',
    top: '50%',
    left: 12,
    right: 12,
    height: 2,
    background: '#ed2923',
    boxShadow: '0 0 14px #ed2923'
  }
})), /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: 17,
    fontWeight: 700,
    textTransform: 'lowercase',
    marginTop: 28
  }
}, "scan een barcode"), /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: 13,
    color: 'rgba(255,255,255,.6)',
    marginTop: 6,
    textAlign: 'center',
    maxWidth: 240
  }
}, "houd je camera op de barcode van een product om de prijs en voorraad te zien.")));

// ──────────────────────────────────────────────────────────────────
// ACCOUNT
// ──────────────────────────────────────────────────────────────────
const AppAccount = () => /*#__PURE__*/React.createElement("div", {
  style: {
    paddingBottom: 24
  }
}, /*#__PURE__*/React.createElement(AppHeader, {
  title: "mij"
}), /*#__PURE__*/React.createElement("div", {
  style: {
    background: '#fff',
    padding: 18,
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    borderBottom: '1px solid var(--border-1)'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    width: 56,
    height: 56,
    borderRadius: 999,
    background: 'var(--label-yellow)',
    color: '#14100c',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 700,
    fontSize: 22
  }
}, "L"), /*#__PURE__*/React.createElement("div", {
  style: {
    flex: 1
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: 16,
    fontWeight: 700
  }
}, "hoi Lotte"), /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: 12,
    color: 'var(--fg-3)'
  }
}, "lid sinds 2021 \xB7 38 bestellingen")), /*#__PURE__*/React.createElement("button", {
  style: {
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    color: 'var(--hema-red)',
    fontFamily: 'inherit',
    fontWeight: 600,
    fontSize: 13
  }
}, "bewerken")), /*#__PURE__*/React.createElement("div", {
  style: {
    margin: 16,
    padding: 16,
    background: '#ed2923',
    color: '#fff',
    borderRadius: 12
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: 11,
    fontWeight: 700,
    opacity: .85,
    letterSpacing: '0.04em',
    textTransform: 'uppercase'
  }
}, "meer hema"), /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: 28,
    fontWeight: 700,
    marginTop: 4
  }
}, "2.450 punten"), /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: 12,
    opacity: .9,
    marginTop: 2
  }
}, "nog 550 voor je volgende voordeel"), /*#__PURE__*/React.createElement("div", {
  style: {
    height: 6,
    borderRadius: 999,
    background: 'rgba(255,255,255,.25)',
    marginTop: 10,
    overflow: 'hidden'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    width: '82%',
    height: '100%',
    background: '#fff'
  }
}))), /*#__PURE__*/React.createElement("div", {
  style: {
    background: '#fff'
  }
}, /*#__PURE__*/React.createElement(AppListRow, {
  icon: "package",
  title: "mijn bestellingen",
  sub: "2 onderweg"
}), /*#__PURE__*/React.createElement(AppListRow, {
  icon: "heart",
  title: "favorieten",
  sub: "12 producten"
}), /*#__PURE__*/React.createElement(AppListRow, {
  icon: "pin",
  title: "winkel zoeker",
  sub: "naaste: amsterdam kalverstraat"
}), /*#__PURE__*/React.createElement(AppListRow, {
  icon: "gift",
  title: "cadeaukaart",
  sub: "saldo: \u20AC 25"
}), /*#__PURE__*/React.createElement(AppListRow, {
  icon: "truck",
  title: "bezorgadressen"
}), /*#__PURE__*/React.createElement(AppListRow, {
  icon: "settings",
  title: "instellingen"
})), /*#__PURE__*/React.createElement("div", {
  style: {
    textAlign: 'center',
    padding: 24,
    fontSize: 12,
    color: 'var(--fg-3)'
  }
}, "hema app \xB7 v4.21.0"));
window.AppScreens = {
  AppHome,
  AppBrowse,
  AppProduct,
  AppBag,
  AppScan,
  AppAccount
};
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app/AppScreens.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app/app.jsx
try { (() => {
// app.jsx — wires up tabs and product drill-in inside an iOS device frame.

const {
  useState
} = React;
const {
  AppHome,
  AppBrowse,
  AppProduct,
  AppBag,
  AppScan,
  AppAccount
} = window.AppScreens;
function HemaApp() {
  const [tab, setTab] = useState('home');
  const [view, setView] = useState({
    name: 'home',
    arg: null
  });
  const [cart, setCart] = useState([]);
  const onNav = (name, arg) => setView({
    name,
    arg
  });
  const onTab = t => {
    setTab(t);
    setView({
      name: t,
      arg: null
    });
  };
  const addToBag = p => {
    setCart(c => {
      const f = c.find(i => i.id === p.id);
      return f ? c.map(i => i.id === p.id ? {
        ...i,
        qty: i.qty + 1
      } : i) : [...c, {
        id: p.id,
        qty: 1
      }];
    });
    setTab('bag');
    setView({
      name: 'bag',
      arg: null
    });
  };
  const bagCount = cart.reduce((s, i) => s + i.qty, 0);

  // Render the active screen. Product screen is a sub-route of any tab.
  let body;
  if (view.name === 'product') body = /*#__PURE__*/React.createElement(AppProduct, {
    id: view.arg,
    onAdd: addToBag,
    onBack: () => onTab(tab)
  });else if (view.name === 'home') body = /*#__PURE__*/React.createElement(AppHome, {
    onNav: onNav
  });else if (view.name === 'browse') body = /*#__PURE__*/React.createElement(AppBrowse, {
    onNav: onNav,
    catFilter: view.arg
  });else if (view.name === 'bag') body = /*#__PURE__*/React.createElement(AppBag, {
    cart: cart,
    setCart: setCart,
    onNav: n => {
      setTab(n);
      setView({
        name: n,
        arg: null
      });
    }
  });else if (view.name === 'scan') body = /*#__PURE__*/React.createElement(AppScan, null);else if (view.name === 'account') body = /*#__PURE__*/React.createElement(AppAccount, null);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      minHeight: '100vh',
      background: '#f0eee9',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '40px 16px'
    }
  }, /*#__PURE__*/React.createElement(IOSDevice, {
    width: 402,
    height: 874,
    dark: view.name === 'scan'
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: view.name === 'scan' ? '#14100c' : 'var(--bg-canvas)',
      paddingTop: 50
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflow: 'auto',
      position: 'relative'
    }
  }, body), /*#__PURE__*/React.createElement(AppTabBar, {
    active: tab,
    onTab: onTab,
    bagCount: bagCount
  }))));
}
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(/*#__PURE__*/React.createElement(HemaApp, null));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app/app.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app/data.js
try { (() => {
// Same fake catalogue as the web kit (duplicated so the app folder is self-contained).
const PRODUCTS = [{
  id: 'n1',
  name: 'notitieboekje a5',
  price: 3,
  cat: 'kantoor',
  color: '#f5c518',
  badge: 'nieuw'
}, {
  id: 'n2',
  name: 'drinkbeker stip teal',
  price: 4,
  cat: 'koken',
  color: '#2aa8a8'
}, {
  id: 'n3',
  name: 'badmat zacht roze',
  price: 6,
  was: 9,
  cat: 'badkamer',
  color: '#ec6ca0',
  badge: '-33%'
}, {
  id: 'n4',
  name: 'plaid lichtblauw',
  price: 12,
  cat: 'wonen',
  color: '#4ab4e6'
}, {
  id: 'n5',
  name: 'kaarsenset 3 stuks',
  price: 5,
  cat: 'wonen',
  color: '#f08d2c'
}, {
  id: 'n6',
  name: 'theelichtjes 50 st',
  price: 4,
  cat: 'wonen',
  color: '#1a1a1a'
}, {
  id: 'n7',
  name: 'kookboek alledag',
  price: 10,
  cat: 'koken',
  color: '#6cb33e',
  badge: 'nieuw'
}, {
  id: 'n8',
  name: 'handdoek wafel groen',
  price: 7,
  cat: 'badkamer',
  color: '#6cb33e'
}, {
  id: 'n9',
  name: 'beker met deksel',
  price: 5,
  was: 8,
  cat: 'koken',
  color: '#7b51a1',
  badge: '-38%'
}];
const CATEGORIES = [{
  id: 'wonen',
  label: 'wonen',
  color: '#f5c518'
}, {
  id: 'koken',
  label: 'koken',
  color: '#2aa8a8'
}, {
  id: 'badkamer',
  label: 'badkamer',
  color: '#ec6ca0'
}, {
  id: 'kleding',
  label: 'kleding',
  color: '#1f6fb4'
}, {
  id: 'kantoor',
  label: 'kantoor',
  color: '#f08d2c'
}, {
  id: 'verzorging',
  label: 'verzorging',
  color: '#6cb33e'
}];
window.HEMA_DATA = {
  PRODUCTS,
  CATEGORIES
};
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app/data.js", error: String((e && e.message) || e) }); }

// ui_kits/app/ios-frame.jsx
try { (() => {
// iOS.jsx — Simplified iOS 26 (Liquid Glass) device frame
// Based on the iOS 26 UI Kit + Figma status bar spec. No assets, no deps.
// Exports: IOSDevice, IOSStatusBar, IOSNavBar, IOSGlassPill, IOSList, IOSListRow, IOSKeyboard

// ─────────────────────────────────────────────────────────────
// Status bar
// ─────────────────────────────────────────────────────────────
function IOSStatusBar({
  dark = false,
  time = '9:41'
}) {
  const c = dark ? '#fff' : '#000';
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 154,
      alignItems: 'center',
      justifyContent: 'center',
      padding: '21px 24px 19px',
      boxSizing: 'border-box',
      position: 'relative',
      zIndex: 20,
      width: '100%'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      height: 22,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      paddingTop: 1.5
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: '-apple-system, "SF Pro", system-ui',
      fontWeight: 590,
      fontSize: 17,
      lineHeight: '22px',
      color: c
    }
  }, time)), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      height: 22,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
      paddingTop: 1,
      paddingRight: 1
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: "19",
    height: "12",
    viewBox: "0 0 19 12"
  }, /*#__PURE__*/React.createElement("rect", {
    x: "0",
    y: "7.5",
    width: "3.2",
    height: "4.5",
    rx: "0.7",
    fill: c
  }), /*#__PURE__*/React.createElement("rect", {
    x: "4.8",
    y: "5",
    width: "3.2",
    height: "7",
    rx: "0.7",
    fill: c
  }), /*#__PURE__*/React.createElement("rect", {
    x: "9.6",
    y: "2.5",
    width: "3.2",
    height: "9.5",
    rx: "0.7",
    fill: c
  }), /*#__PURE__*/React.createElement("rect", {
    x: "14.4",
    y: "0",
    width: "3.2",
    height: "12",
    rx: "0.7",
    fill: c
  })), /*#__PURE__*/React.createElement("svg", {
    width: "17",
    height: "12",
    viewBox: "0 0 17 12"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M8.5 3.2C10.8 3.2 12.9 4.1 14.4 5.6L15.5 4.5C13.7 2.7 11.2 1.5 8.5 1.5C5.8 1.5 3.3 2.7 1.5 4.5L2.6 5.6C4.1 4.1 6.2 3.2 8.5 3.2Z",
    fill: c
  }), /*#__PURE__*/React.createElement("path", {
    d: "M8.5 6.8C9.9 6.8 11.1 7.3 12 8.2L13.1 7.1C11.8 5.9 10.2 5.1 8.5 5.1C6.8 5.1 5.2 5.9 3.9 7.1L5 8.2C5.9 7.3 7.1 6.8 8.5 6.8Z",
    fill: c
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "8.5",
    cy: "10.5",
    r: "1.5",
    fill: c
  })), /*#__PURE__*/React.createElement("svg", {
    width: "27",
    height: "13",
    viewBox: "0 0 27 13"
  }, /*#__PURE__*/React.createElement("rect", {
    x: "0.5",
    y: "0.5",
    width: "23",
    height: "12",
    rx: "3.5",
    stroke: c,
    strokeOpacity: "0.35",
    fill: "none"
  }), /*#__PURE__*/React.createElement("rect", {
    x: "2",
    y: "2",
    width: "20",
    height: "9",
    rx: "2",
    fill: c
  }), /*#__PURE__*/React.createElement("path", {
    d: "M25 4.5V8.5C25.8 8.2 26.5 7.2 26.5 6.5C26.5 5.8 25.8 4.8 25 4.5Z",
    fill: c,
    fillOpacity: "0.4"
  }))));
}

// ─────────────────────────────────────────────────────────────
// Liquid glass pill — blur + tint + shine
// ─────────────────────────────────────────────────────────────
function IOSGlassPill({
  children,
  dark = false,
  style = {}
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      height: 44,
      minWidth: 44,
      borderRadius: 9999,
      position: 'relative',
      overflow: 'hidden',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      boxShadow: dark ? '0 2px 6px rgba(0,0,0,0.35), 0 6px 16px rgba(0,0,0,0.2)' : '0 1px 3px rgba(0,0,0,0.07), 0 3px 10px rgba(0,0,0,0.06)',
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      borderRadius: 9999,
      backdropFilter: 'blur(12px) saturate(180%)',
      WebkitBackdropFilter: 'blur(12px) saturate(180%)',
      background: dark ? 'rgba(120,120,128,0.28)' : 'rgba(255,255,255,0.5)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      borderRadius: 9999,
      boxShadow: dark ? 'inset 1.5px 1.5px 1px rgba(255,255,255,0.15), inset -1px -1px 1px rgba(255,255,255,0.08)' : 'inset 1.5px 1.5px 1px rgba(255,255,255,0.7), inset -1px -1px 1px rgba(255,255,255,0.4)',
      border: dark ? '0.5px solid rgba(255,255,255,0.15)' : '0.5px solid rgba(0,0,0,0.06)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      zIndex: 1,
      display: 'flex',
      alignItems: 'center',
      padding: '0 4px'
    }
  }, children));
}

// ─────────────────────────────────────────────────────────────
// Navigation bar — glass pills + large title
// ─────────────────────────────────────────────────────────────
function IOSNavBar({
  title = 'Title',
  dark = false,
  trailingIcon = true
}) {
  const muted = dark ? 'rgba(255,255,255,0.6)' : '#404040';
  const text = dark ? '#fff' : '#000';
  const pillIcon = content => /*#__PURE__*/React.createElement(IOSGlassPill, {
    dark: dark
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 36,
      height: 36,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, content));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      paddingTop: 62,
      paddingBottom: 10,
      position: 'relative',
      zIndex: 5
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 16px'
    }
  }, pillIcon(/*#__PURE__*/React.createElement("svg", {
    width: "12",
    height: "20",
    viewBox: "0 0 12 20",
    fill: "none",
    style: {
      marginLeft: -1
    }
  }, /*#__PURE__*/React.createElement("path", {
    d: "M10 2L2 10l8 8",
    stroke: muted,
    strokeWidth: "2.5",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }))), trailingIcon && pillIcon(/*#__PURE__*/React.createElement("svg", {
    width: "22",
    height: "6",
    viewBox: "0 0 22 6"
  }, /*#__PURE__*/React.createElement("circle", {
    cx: "3",
    cy: "3",
    r: "2.5",
    fill: muted
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "11",
    cy: "3",
    r: "2.5",
    fill: muted
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "19",
    cy: "3",
    r: "2.5",
    fill: muted
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '0 16px',
      fontFamily: '-apple-system, system-ui',
      fontSize: 34,
      fontWeight: 700,
      lineHeight: '41px',
      color: text,
      letterSpacing: 0.4
    }
  }, title));
}

// ─────────────────────────────────────────────────────────────
// Grouped list (inset card, r:26) + row (52px)
// ─────────────────────────────────────────────────────────────
function IOSListRow({
  title,
  detail,
  icon,
  chevron = true,
  isLast = false,
  dark = false
}) {
  const text = dark ? '#fff' : '#000';
  const sec = dark ? 'rgba(235,235,245,0.6)' : 'rgba(60,60,67,0.6)';
  const ter = dark ? 'rgba(235,235,245,0.3)' : 'rgba(60,60,67,0.3)';
  const sep = dark ? 'rgba(84,84,88,0.65)' : 'rgba(60,60,67,0.12)';
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      minHeight: 52,
      padding: '0 16px',
      position: 'relative',
      fontFamily: '-apple-system, system-ui',
      fontSize: 17,
      letterSpacing: -0.43
    }
  }, icon && /*#__PURE__*/React.createElement("div", {
    style: {
      width: 30,
      height: 30,
      borderRadius: 7,
      background: icon,
      marginRight: 12,
      flexShrink: 0
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      color: text
    }
  }, title), detail && /*#__PURE__*/React.createElement("span", {
    style: {
      color: sec,
      marginRight: 6
    }
  }, detail), chevron && /*#__PURE__*/React.createElement("svg", {
    width: "8",
    height: "14",
    viewBox: "0 0 8 14",
    style: {
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("path", {
    d: "M1 1l6 6-6 6",
    stroke: ter,
    strokeWidth: "2",
    fill: "none",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  })), !isLast && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      bottom: 0,
      right: 0,
      left: icon ? 58 : 16,
      height: 0.5,
      background: sep
    }
  }));
}
function IOSList({
  header,
  children,
  dark = false
}) {
  const hc = dark ? 'rgba(235,235,245,0.6)' : 'rgba(60,60,67,0.6)';
  const bg = dark ? '#1C1C1E' : '#fff';
  return /*#__PURE__*/React.createElement("div", null, header && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: '-apple-system, system-ui',
      fontSize: 13,
      color: hc,
      textTransform: 'uppercase',
      padding: '8px 36px 6px',
      letterSpacing: -0.08
    }
  }, header), /*#__PURE__*/React.createElement("div", {
    style: {
      background: bg,
      borderRadius: 26,
      margin: '0 16px',
      overflow: 'hidden'
    }
  }, children));
}

// ─────────────────────────────────────────────────────────────
// Device frame
// ─────────────────────────────────────────────────────────────
function IOSDevice({
  children,
  width = 402,
  height = 874,
  dark = false,
  title,
  keyboard = false
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      width,
      height,
      borderRadius: 48,
      overflow: 'hidden',
      position: 'relative',
      background: dark ? '#000' : '#F2F2F7',
      boxShadow: '0 40px 80px rgba(0,0,0,0.18), 0 0 0 1px rgba(0,0,0,0.12)',
      fontFamily: '-apple-system, system-ui, sans-serif',
      WebkitFontSmoothing: 'antialiased'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 11,
      left: '50%',
      transform: 'translateX(-50%)',
      width: 126,
      height: 37,
      borderRadius: 24,
      background: '#000',
      zIndex: 50
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      zIndex: 10
    }
  }, /*#__PURE__*/React.createElement(IOSStatusBar, {
    dark: dark
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      height: '100%',
      display: 'flex',
      flexDirection: 'column'
    }
  }, title !== undefined && /*#__PURE__*/React.createElement(IOSNavBar, {
    title: title,
    dark: dark
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflow: 'auto'
    }
  }, children), keyboard && /*#__PURE__*/React.createElement(IOSKeyboard, {
    dark: dark
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      zIndex: 60,
      height: 34,
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'flex-end',
      paddingBottom: 8,
      pointerEvents: 'none'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 139,
      height: 5,
      borderRadius: 100,
      background: dark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.25)'
    }
  })));
}

// ─────────────────────────────────────────────────────────────
// Keyboard — iOS 26 liquid glass
// ─────────────────────────────────────────────────────────────
function IOSKeyboard({
  dark = false
}) {
  const glyph = dark ? 'rgba(255,255,255,0.7)' : '#595959';
  const sugg = dark ? 'rgba(255,255,255,0.6)' : '#333';
  const keyBg = dark ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.85)';

  // special-key icons
  const icons = {
    shift: /*#__PURE__*/React.createElement("svg", {
      width: "19",
      height: "17",
      viewBox: "0 0 19 17"
    }, /*#__PURE__*/React.createElement("path", {
      d: "M9.5 1L1 9.5h4.5V16h8V9.5H18L9.5 1z",
      fill: glyph
    })),
    del: /*#__PURE__*/React.createElement("svg", {
      width: "23",
      height: "17",
      viewBox: "0 0 23 17"
    }, /*#__PURE__*/React.createElement("path", {
      d: "M7 1h13a2 2 0 012 2v11a2 2 0 01-2 2H7l-6-7.5L7 1z",
      fill: "none",
      stroke: glyph,
      strokeWidth: "1.6",
      strokeLinejoin: "round"
    }), /*#__PURE__*/React.createElement("path", {
      d: "M10 5l7 7M17 5l-7 7",
      stroke: glyph,
      strokeWidth: "1.6",
      strokeLinecap: "round"
    })),
    ret: /*#__PURE__*/React.createElement("svg", {
      width: "20",
      height: "14",
      viewBox: "0 0 20 14"
    }, /*#__PURE__*/React.createElement("path", {
      d: "M18 1v6H4m0 0l4-4M4 7l4 4",
      fill: "none",
      stroke: "#fff",
      strokeWidth: "1.8",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }))
  };
  const key = (content, {
    w,
    flex,
    ret,
    fs = 25,
    k
  } = {}) => /*#__PURE__*/React.createElement("div", {
    key: k,
    style: {
      height: 42,
      borderRadius: 8.5,
      flex: flex ? 1 : undefined,
      width: w,
      minWidth: 0,
      background: ret ? '#08f' : keyBg,
      boxShadow: '0 1px 0 rgba(0,0,0,0.075)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: '-apple-system, "SF Compact", system-ui',
      fontSize: fs,
      fontWeight: 458,
      color: ret ? '#fff' : glyph
    }
  }, content);
  const row = (keys, pad = 0) => /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6.5,
      justifyContent: 'center',
      padding: `0 ${pad}px`
    }
  }, keys.map(l => key(l, {
    flex: true,
    k: l
  })));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      zIndex: 15,
      borderRadius: 27,
      overflow: 'hidden',
      padding: '11px 0 2px',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      boxShadow: dark ? '0 -2px 20px rgba(0,0,0,0.09)' : '0 -1px 6px rgba(0,0,0,0.018), 0 -3px 20px rgba(0,0,0,0.012)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      borderRadius: 27,
      backdropFilter: 'blur(12px) saturate(180%)',
      WebkitBackdropFilter: 'blur(12px) saturate(180%)',
      background: dark ? 'rgba(120,120,128,0.14)' : 'rgba(255,255,255,0.25)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      borderRadius: 27,
      boxShadow: dark ? 'inset 1.5px 1.5px 1px rgba(255,255,255,0.15)' : 'inset 1.5px 1.5px 1px rgba(255,255,255,0.7), inset -1px -1px 1px rgba(255,255,255,0.4)',
      border: dark ? '0.5px solid rgba(255,255,255,0.15)' : '0.5px solid rgba(0,0,0,0.06)',
      pointerEvents: 'none'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 20,
      alignItems: 'center',
      padding: '8px 22px 13px',
      width: '100%',
      boxSizing: 'border-box',
      position: 'relative'
    }
  }, ['"The"', 'the', 'to'].map((w, i) => /*#__PURE__*/React.createElement(React.Fragment, {
    key: i
  }, i > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      width: 1,
      height: 25,
      background: '#ccc',
      opacity: 0.3
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      textAlign: 'center',
      fontFamily: '-apple-system, system-ui',
      fontSize: 17,
      color: sugg,
      letterSpacing: -0.43,
      lineHeight: '22px'
    }
  }, w)))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 13,
      padding: '0 6.5px',
      width: '100%',
      boxSizing: 'border-box',
      position: 'relative'
    }
  }, row(['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p']), row(['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'], 20), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 14.25,
      alignItems: 'center'
    }
  }, key(icons.shift, {
    w: 45,
    k: 'shift'
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6.5,
      flex: 1
    }
  }, ['z', 'x', 'c', 'v', 'b', 'n', 'm'].map(l => key(l, {
    flex: true,
    k: l
  }))), key(icons.del, {
    w: 45,
    k: 'del'
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6,
      alignItems: 'center'
    }
  }, key('ABC', {
    w: 92.25,
    fs: 18,
    k: 'abc'
  }), key('', {
    flex: true,
    k: 'space'
  }), key(icons.ret, {
    w: 92.25,
    ret: true,
    k: 'ret'
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 56,
      width: '100%',
      position: 'relative'
    }
  }));
}
Object.assign(window, {
  IOSDevice,
  IOSStatusBar,
  IOSNavBar,
  IOSGlassPill,
  IOSList,
  IOSListRow,
  IOSKeyboard
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app/ios-frame.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web/CategoryTile.jsx
try { (() => {
// CategoryTile.jsx and ServiceRow.jsx — shop-the-categories tiles + 4-up service bar.

const CategoryTile = ({
  cat,
  onClick
}) => /*#__PURE__*/React.createElement("button", {
  onClick: () => onClick && onClick(cat),
  style: {
    background: cat.color,
    borderRadius: 12,
    border: 'none',
    cursor: 'pointer',
    aspectRatio: '1/1',
    padding: 18,
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'flex-start',
    color: cat.color === '#f5c518' || cat.color === '#b9ce47' ? '#14100c' : '#fff',
    fontSize: 18,
    fontWeight: 700,
    textAlign: 'left',
    textTransform: 'lowercase',
    lineHeight: 1.05,
    letterSpacing: '-0.01em',
    transition: 'transform .18s var(--ease-out)'
  },
  onMouseEnter: e => e.currentTarget.style.transform = 'translateY(-2px)',
  onMouseLeave: e => e.currentTarget.style.transform = 'translateY(0)'
}, cat.label);
const ServiceRow = () => {
  const items = [{
    ic: 'truck',
    t: 'gratis verzending',
    s: 'vanaf € 30'
  }, {
    ic: 'pin',
    t: '750 winkels',
    s: 'altijd één in de buurt'
  }, {
    ic: 'return',
    t: 'gemakkelijk retour',
    s: 'binnen 60 dagen'
  }, {
    ic: 'check',
    t: '100% hema',
    s: 'zelf ontworpen'
  }];
  return /*#__PURE__*/React.createElement("section", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(4, 1fr)',
      gap: 0,
      background: 'var(--bg-subtle)',
      borderRadius: 16,
      padding: '24px 0',
      margin: '32px 0'
    }
  }, items.map((i, idx) => /*#__PURE__*/React.createElement("div", {
    key: idx,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      padding: '0 24px',
      borderRight: idx < 3 ? '1px solid var(--border-1)' : 'none'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 44,
      height: 44,
      borderRadius: 999,
      background: '#fff',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: 'var(--hema-red)',
      flex: '0 0 auto'
    }
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: i.ic,
    size: 22
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      fontWeight: 700
    }
  }, i.t), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: 'var(--fg-3)'
    }
  }, i.s)))));
};
window.HemaCategoryTile = CategoryTile;
window.HemaServiceRow = ServiceRow;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web/CategoryTile.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web/Footer.jsx
try { (() => {
// Footer.jsx — flat footer, white ground, hairline top border.

const COLS = [{
  title: 'klantenservice',
  items: ['contact', 'bestellen', 'bezorging', 'retour', 'veelgestelde vragen']
}, {
  title: 'over hema',
  items: ['ons verhaal', 'duurzaamheid', 'werken bij hema', 'pers']
}, {
  title: 'praktisch',
  items: ['winkels', 'cadeaukaart', 'fotoservice', 'verjaardagstaart', 'lidmaatschap']
}];
const Footer = () => /*#__PURE__*/React.createElement("footer", {
  style: {
    borderTop: '1px solid var(--border-1)',
    background: '#fff',
    marginTop: 80,
    padding: '48px 24px 32px'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    maxWidth: 1280,
    margin: '0 auto'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'grid',
    gridTemplateColumns: '1.2fr repeat(3, 1fr)',
    gap: 40,
    marginBottom: 48
  }
}, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("img", {
  src: "../../assets/logo.svg",
  alt: "hema",
  style: {
    width: 56,
    height: 56,
    marginBottom: 14
  }
}), /*#__PURE__*/React.createElement("p", {
  style: {
    fontSize: 14,
    color: 'var(--fg-2)',
    lineHeight: 1.55,
    maxWidth: 280,
    margin: 0
  }
}, "al bijna 100 jaar handig in huis. ontwerpen we zelf, op het hoofdkantoor in amsterdam.")), COLS.map(c => /*#__PURE__*/React.createElement("div", {
  key: c.title
}, /*#__PURE__*/React.createElement("h4", {
  style: {
    fontSize: 13,
    fontWeight: 700,
    textTransform: 'lowercase',
    marginBottom: 14
  }
}, c.title), /*#__PURE__*/React.createElement("ul", {
  style: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 10
  }
}, c.items.map(i => /*#__PURE__*/React.createElement("li", {
  key: i
}, /*#__PURE__*/React.createElement("a", {
  href: "#",
  style: {
    color: 'var(--fg-2)',
    fontSize: 14,
    textDecoration: 'none'
  }
}, i))))))), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 24,
    borderTop: '1px solid var(--border-1)',
    fontSize: 12,
    color: 'var(--fg-3)'
  }
}, /*#__PURE__*/React.createElement("span", null, "\xA9 hema b.v. \xB7 alle rechten voorbehouden"), /*#__PURE__*/React.createElement("span", {
  style: {
    display: 'flex',
    gap: 16
  }
}, /*#__PURE__*/React.createElement("a", {
  href: "#",
  style: {
    color: 'var(--fg-3)'
  }
}, "privacy"), /*#__PURE__*/React.createElement("a", {
  href: "#",
  style: {
    color: 'var(--fg-3)'
  }
}, "cookies"), /*#__PURE__*/React.createElement("a", {
  href: "#",
  style: {
    color: 'var(--fg-3)'
  }
}, "algemene voorwaarden"), /*#__PURE__*/React.createElement("a", {
  href: "#",
  style: {
    color: 'var(--fg-3)'
  }
}, "nederland \xB7 \u20AC")))));
window.HemaFooter = Footer;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web/Footer.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web/Header.jsx
try { (() => {
// Header.jsx — promo bar + sticky shop header. Click "hema" to go home.

const PromoBar = () => /*#__PURE__*/React.createElement("div", {
  style: {
    height: 32,
    background: 'var(--bg-promo)',
    color: 'var(--fg-inverse)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 13,
    fontWeight: 600,
    gap: 8
  }
}, "gratis verzending vanaf \u20AC 30 \u2014 ", /*#__PURE__*/React.createElement("a", {
  href: "#",
  style: {
    color: '#fff',
    textDecoration: 'underline'
  }
}, "bekijk de actie"));
const NAV_LINKS = ['nieuw', 'aanbiedingen', 'wonen', 'koken', 'badkamer', 'kleding', 'kantoor', 'verzorging', 'eten & drinken'];
const Header = ({
  onNav,
  cartCount = 0,
  onSearch
}) => {
  const [q, setQ] = React.useState('');
  return /*#__PURE__*/React.createElement("header", {
    style: {
      position: 'sticky',
      top: 0,
      zIndex: 50,
      background: '#fff'
    }
  }, /*#__PURE__*/React.createElement(PromoBar, null), /*#__PURE__*/React.createElement("div", {
    style: {
      boxShadow: 'var(--shadow-sticky)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 1280,
      margin: '0 auto',
      height: 72,
      display: 'flex',
      alignItems: 'center',
      gap: 22,
      padding: '0 24px'
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: "../../assets/logo.svg",
    alt: "hema",
    onClick: () => onNav('home'),
    style: {
      width: 48,
      height: 48,
      cursor: 'pointer',
      flex: '0 0 auto'
    }
  }), /*#__PURE__*/React.createElement("form", {
    onSubmit: e => {
      e.preventDefault();
      onSearch && onSearch(q);
    },
    style: {
      flex: 1,
      background: 'var(--stone-50)',
      borderRadius: 999,
      height: 44,
      display: 'flex',
      alignItems: 'center',
      padding: '0 18px',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: "search",
    size: 20,
    color: "var(--fg-2)"
  }), /*#__PURE__*/React.createElement("input", {
    value: q,
    onChange: e => setQ(e.target.value),
    placeholder: "waar ben je naar op zoek?",
    style: {
      flex: 1,
      border: 'none',
      outline: 'none',
      background: 'transparent',
      fontFamily: 'inherit',
      fontSize: 14,
      color: 'var(--fg-1)'
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 18,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn--ghost btn--sm",
    style: {
      padding: '6px 8px',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: "user"
  }), " ", /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 600,
      fontSize: 13
    }
  }, "inloggen")), /*#__PURE__*/React.createElement("button", {
    className: "btn btn--ghost btn--sm",
    style: {
      padding: 6
    }
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: "heart"
  })), /*#__PURE__*/React.createElement("button", {
    onClick: () => onNav('cart'),
    className: "btn btn--ghost btn--sm",
    style: {
      padding: 6,
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: "cart"
  }), cartCount > 0 && /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      top: -2,
      right: -2,
      background: 'var(--hema-red)',
      color: '#fff',
      fontSize: 10,
      fontWeight: 700,
      borderRadius: 999,
      minWidth: 18,
      height: 18,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '0 4px'
    }
  }, cartCount)))), /*#__PURE__*/React.createElement("nav", {
    style: {
      maxWidth: 1280,
      margin: '0 auto',
      padding: '0 24px 14px',
      display: 'flex',
      gap: 22,
      flexWrap: 'wrap'
    }
  }, NAV_LINKS.map((l, i) => /*#__PURE__*/React.createElement("a", {
    key: l,
    href: "#",
    onClick: e => {
      e.preventDefault();
      onNav('category', l);
    },
    style: {
      fontSize: 14,
      fontWeight: 600,
      color: i === 0 ? 'var(--hema-red)' : 'var(--fg-1)',
      textDecoration: 'none',
      textTransform: 'lowercase'
    }
  }, l)))));
};
window.HemaHeader = Header;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web/Header.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web/Hero.jsx
try { (() => {
// Hero.jsx — full-bleed coloured hero with display headline.

const Hero = ({
  onNav
}) => /*#__PURE__*/React.createElement("section", {
  style: {
    background: 'var(--label-yellow)',
    borderRadius: 16,
    overflow: 'hidden',
    margin: '24px 0 32px',
    minHeight: 360,
    display: 'grid',
    gridTemplateColumns: '1.1fr 1fr',
    alignItems: 'center'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    padding: '48px 56px'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'var(--fg-2)',
    marginBottom: 16
  }
}, "nu in de winkel"), /*#__PURE__*/React.createElement("h1", {
  style: {
    fontSize: 64,
    fontWeight: 700,
    lineHeight: 0.95,
    letterSpacing: '-0.03em',
    textTransform: 'lowercase',
    color: 'var(--fg-1)',
    margin: '0 0 18px'
  }
}, "handig in huis,", /*#__PURE__*/React.createElement("br", null), "al bijna 100 jaar"), /*#__PURE__*/React.createElement("p", {
  style: {
    fontSize: 18,
    color: 'var(--fg-2)',
    maxWidth: 420,
    lineHeight: 1.45,
    margin: '0 0 28px'
  }
}, "ontdek nieuwe favorieten voor in huis. zelf ontworpen, altijd voor een prijsje."), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    gap: 12
  }
}, /*#__PURE__*/React.createElement("button", {
  className: "btn btn--primary btn--lg",
  onClick: () => onNav('category', 'wonen')
}, "shop nieuw"), /*#__PURE__*/React.createElement("button", {
  className: "btn btn--outline btn--lg"
}, "vind een winkel"))), /*#__PURE__*/React.createElement("div", {
  style: {
    height: '100%',
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gridTemplateRows: '1fr 1fr',
    gap: 12,
    padding: 28
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    background: '#ed2923',
    borderRadius: 12
  }
}), /*#__PURE__*/React.createElement("div", {
  style: {
    background: '#fff',
    borderRadius: 12,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  }
}, /*#__PURE__*/React.createElement("svg", {
  viewBox: "0 0 100 100",
  style: {
    width: '60%'
  }
}, /*#__PURE__*/React.createElement("circle", {
  cx: "50",
  cy: "50",
  r: "36",
  fill: "#2aa8a8"
}), /*#__PURE__*/React.createElement("circle", {
  cx: "40",
  cy: "42",
  r: "4",
  fill: "#fff"
}), /*#__PURE__*/React.createElement("circle", {
  cx: "60",
  cy: "42",
  r: "4",
  fill: "#fff"
}), /*#__PURE__*/React.createElement("path", {
  d: "M40 60 Q50 70 60 60",
  stroke: "#fff",
  strokeWidth: "4",
  fill: "none",
  strokeLinecap: "round"
}))), /*#__PURE__*/React.createElement("div", {
  style: {
    background: '#fff',
    borderRadius: 12,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  }
}, /*#__PURE__*/React.createElement("svg", {
  viewBox: "0 0 100 100",
  style: {
    width: '70%'
  }
}, /*#__PURE__*/React.createElement("rect", {
  x: "20",
  y: "30",
  width: "60",
  height: "50",
  rx: "6",
  fill: "#ec6ca0"
}), /*#__PURE__*/React.createElement("rect", {
  x: "32",
  y: "40",
  width: "36",
  height: "6",
  fill: "#fff",
  opacity: ".7"
}), /*#__PURE__*/React.createElement("rect", {
  x: "32",
  y: "50",
  width: "28",
  height: "6",
  fill: "#fff",
  opacity: ".5"
}))), /*#__PURE__*/React.createElement("div", {
  style: {
    background: '#1a1a1a',
    borderRadius: 12,
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    padding: 16
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    fontSize: 22,
    fontWeight: 700,
    textTransform: 'lowercase',
    lineHeight: 1
  }
}, "al", /*#__PURE__*/React.createElement("br", null), "\u20AC\xA01"))));
window.HemaHero = Hero;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web/Hero.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web/HomeSections.jsx
try { (() => {
// HomeSections.jsx — interactive home-page modules.
// Each component is exported to window.* so Screens.jsx can compose them.

const {
  PRODUCTS: HS_PRODUCTS,
  CATEGORIES: HS_CATEGORIES
} = window.HEMA_DATA;

// ---- shared helpers --------------------------------------------------------
const swatch = (color, w = 200, h = 200) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="#f5f3ee"/>
  <rect x="${w * .2}" y="${h * .2}" width="${w * .6}" height="${h * .6}" rx="${Math.min(w, h) * .05}" fill="${color}"/>
</svg>`)}`;
const eyebrow = (children, color = 'var(--fg-3)') => /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color,
    marginBottom: 8
  }
}, children);
const sectionTitle = (title, link, onLink) => /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 18
  }
}, /*#__PURE__*/React.createElement("h2", {
  style: {
    fontSize: 28,
    fontWeight: 700,
    textTransform: 'lowercase',
    letterSpacing: '-0.01em',
    margin: 0
  }
}, title), link && /*#__PURE__*/React.createElement("a", {
  href: "#",
  onClick: e => {
    e.preventDefault();
    onLink && onLink();
  },
  style: {
    fontSize: 14,
    fontWeight: 600
  }
}, link, " \u2192"));

// ============================================================================
// 1. FLASH DEALS — "dagdeal" countdown + sale grid
// ============================================================================
const FlashDeals = ({
  onNav,
  onAdd
}) => {
  // Count down to midnight (Europe/Amsterdam shopper convention).
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const midnight = React.useMemo(() => {
    const d = new Date();
    d.setHours(24, 0, 0, 0);
    return d.getTime();
  }, []);
  const remaining = Math.max(0, midnight - now);
  const hh = String(Math.floor(remaining / 3600000)).padStart(2, '0');
  const mm = String(Math.floor(remaining % 3600000 / 60000)).padStart(2, '0');
  const ss = String(Math.floor(remaining % 60000 / 1000)).padStart(2, '0');

  // Deterministic "stock sold" % so cards look real but don't jitter.
  const deals = HS_PRODUCTS.filter(p => p.was).slice(0, 4).concat(HS_PRODUCTS.filter(p => !p.was && p.price <= 6).slice(0, 4)).slice(0, 4);
  const TimeBox = ({
    v,
    label
  }) => /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: '#14100c',
      color: '#fff',
      fontSize: 24,
      fontWeight: 700,
      fontVariantNumeric: 'tabular-nums',
      padding: '6px 12px',
      borderRadius: 8,
      minWidth: 48,
      textAlign: 'center'
    }
  }, v), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: '#fff',
      opacity: .85,
      marginTop: 4,
      textTransform: 'uppercase',
      letterSpacing: '0.08em'
    }
  }, label));
  return /*#__PURE__*/React.createElement("section", {
    style: {
      marginBottom: 56
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--hema-red)',
      color: '#fff',
      borderRadius: '16px 16px 0 0',
      padding: '20px 28px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 16,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: '#fff',
      color: 'var(--hema-red)',
      width: 44,
      height: 44,
      borderRadius: 12,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontWeight: 700,
      fontSize: 22
    }
  }, "%"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      fontWeight: 700,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      opacity: .85
    }
  }, "vandaag"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 24,
      fontWeight: 700,
      lineHeight: 1,
      textTransform: 'lowercase'
    }
  }, "dagdeals \u2014 alleen vandaag"))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      fontWeight: 600,
      marginRight: 6,
      opacity: .9
    }
  }, "nog"), /*#__PURE__*/React.createElement(TimeBox, {
    v: hh,
    label: "uur"
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 22,
      fontWeight: 700,
      color: '#fff',
      opacity: .6,
      marginTop: -10
    }
  }, ":"), /*#__PURE__*/React.createElement(TimeBox, {
    v: mm,
    label: "min"
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 22,
      fontWeight: 700,
      color: '#fff',
      opacity: .6,
      marginTop: -10
    }
  }, ":"), /*#__PURE__*/React.createElement(TimeBox, {
    v: ss,
    label: "sec"
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      background: '#fde9e8',
      borderRadius: '0 0 16px 16px',
      padding: 18,
      display: 'grid',
      gridTemplateColumns: 'repeat(4, 1fr)',
      gap: 12
    }
  }, deals.map((p, i) => {
    const sold = [62, 41, 88, 27][i % 4];
    const price = p.price;
    const was = p.was || Math.round(price * 1.5);
    const pct = Math.round((1 - price / was) * 100);
    return /*#__PURE__*/React.createElement("div", {
      key: p.id,
      onClick: () => onNav('product', p.id),
      style: {
        background: '#fff',
        borderRadius: 12,
        padding: 12,
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        border: '1px solid #fff',
        transition: 'transform .18s, box-shadow .18s'
      },
      onMouseEnter: e => {
        e.currentTarget.style.transform = 'translateY(-2px)';
        e.currentTarget.style.boxShadow = 'var(--shadow-hover)';
      },
      onMouseLeave: e => {
        e.currentTarget.style.transform = '';
        e.currentTarget.style.boxShadow = '';
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        position: 'relative',
        aspectRatio: '1/1',
        background: 'var(--bg-subtle)',
        borderRadius: 8,
        overflow: 'hidden'
      }
    }, /*#__PURE__*/React.createElement("img", {
      src: swatch(p.color),
      alt: p.name,
      style: {
        width: '100%',
        height: '100%'
      }
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        position: 'absolute',
        top: 8,
        left: 8,
        background: 'var(--hema-red)',
        color: '#fff',
        fontSize: 13,
        fontWeight: 700,
        padding: '4px 8px',
        borderRadius: 6,
        lineHeight: 1
      }
    }, "-", pct, "%")), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 14,
        fontWeight: 600,
        lineHeight: 1.25,
        minHeight: 36
      }
    }, p.name), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 6
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 20,
        fontWeight: 700,
        color: 'var(--hema-red)',
        fontVariantNumeric: 'tabular-nums'
      }
    }, "\u20AC\xA0", price), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 13,
        color: 'var(--fg-3)',
        textDecoration: 'line-through'
      }
    }, "\u20AC\xA0", was)), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      style: {
        height: 6,
        background: 'var(--stone-100)',
        borderRadius: 999,
        overflow: 'hidden'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: `${sold}%`,
        height: '100%',
        background: sold > 75 ? 'var(--hema-red)' : 'var(--label-orange)',
        borderRadius: 999,
        transition: 'width 1s'
      }
    })), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        color: 'var(--fg-3)',
        marginTop: 4,
        fontWeight: 600
      }
    }, sold > 75 ? `bijna op — ${100 - sold}% over` : `${sold}% verkocht`)));
  })));
};

// ============================================================================
// 2. BESTSELLERS TOP 10 — ranked carousel with big numbers
// ============================================================================
const BestsellersTop10 = ({
  onNav
}) => {
  const scrollerRef = React.useRef(null);
  const scroll = dx => {
    if (scrollerRef.current) scrollerRef.current.scrollBy({
      left: dx,
      behavior: 'smooth'
    });
  };

  // Pick 10 picks deterministically and combine with rank
  const top = HS_PRODUCTS.slice(0, 10);
  return /*#__PURE__*/React.createElement("section", {
    style: {
      marginBottom: 56
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      marginBottom: 18
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: 28,
      fontWeight: 700,
      textTransform: 'lowercase',
      letterSpacing: '-0.01em',
      margin: 0
    }
  }, "hema top 10"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 14,
      color: 'var(--fg-3)'
    }
  }, "meest gekocht deze week")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => scroll(-400),
    "aria-label": "vorige",
    style: {
      width: 38,
      height: 38,
      borderRadius: 999,
      border: '1px solid var(--border-1)',
      background: '#fff',
      cursor: 'pointer',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: "arrow-left",
    size: 16
  })), /*#__PURE__*/React.createElement("button", {
    onClick: () => scroll(400),
    "aria-label": "volgende",
    style: {
      width: 38,
      height: 38,
      borderRadius: 999,
      border: '1px solid var(--border-1)',
      background: '#fff',
      cursor: 'pointer',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: "arrow-right",
    size: 16
  })))), /*#__PURE__*/React.createElement("div", {
    ref: scrollerRef,
    style: {
      display: 'flex',
      gap: 14,
      overflowX: 'auto',
      scrollSnapType: 'x mandatory',
      paddingBottom: 8,
      scrollbarWidth: 'none'
    }
  }, /*#__PURE__*/React.createElement("style", null, `section [data-top10]::-webkit-scrollbar{display:none}`), top.map((p, i) => {
    const rank = i + 1;
    return /*#__PURE__*/React.createElement("div", {
      key: p.id,
      "data-top10": "",
      onClick: () => onNav('product', p.id),
      style: {
        flex: '0 0 200px',
        scrollSnapAlign: 'start',
        background: '#fff',
        borderRadius: 12,
        padding: 14,
        cursor: 'pointer',
        position: 'relative',
        border: '1px solid var(--border-1)',
        transition: 'transform .18s'
      },
      onMouseEnter: e => {
        e.currentTarget.style.transform = 'translateY(-2px)';
      },
      onMouseLeave: e => {
        e.currentTarget.style.transform = '';
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        position: 'absolute',
        top: -6,
        left: -6,
        width: 44,
        height: 44,
        borderRadius: 12,
        background: rank <= 3 ? 'var(--hema-red)' : '#14100c',
        color: '#fff',
        fontSize: 22,
        fontWeight: 700,
        fontVariantNumeric: 'tabular-nums',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        zIndex: 1
      }
    }, rank), /*#__PURE__*/React.createElement("div", {
      style: {
        aspectRatio: '1/1',
        background: 'var(--bg-subtle)',
        borderRadius: 8,
        overflow: 'hidden',
        marginBottom: 10
      }
    }, /*#__PURE__*/React.createElement("img", {
      src: swatch(p.color),
      alt: p.name,
      style: {
        width: '100%',
        height: '100%'
      }
    })), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 13,
        fontWeight: 600,
        lineHeight: 1.25,
        minHeight: 32
      }
    }, p.name), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        marginTop: 4
      }
    }, [1, 2, 3, 4, 5].map(s => /*#__PURE__*/React.createElement(HemaIcon, {
      key: s,
      name: "star",
      size: 11,
      color: s <= 4 ? '#f5c518' : '#c9c4ba'
    })), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 11,
        color: 'var(--fg-3)',
        marginLeft: 2
      }
    }, "4,", 2 + rank % 7)), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 18,
        fontWeight: 700,
        marginTop: 6,
        fontVariantNumeric: 'tabular-nums'
      }
    }, "\u20AC\xA0", p.price));
  })));
};

// ============================================================================
// 3. VERJAARDAGSTAART CONFIGURATOR — HEMA-classic, interactive
// ============================================================================
const CakeConfigurator = () => {
  const [persons, setPersons] = React.useState(6);
  const [flavor, setFlavor] = React.useState('chocolade');
  const [shape, setShape] = React.useState('rond');
  const [text, setText] = React.useState('gefeliciteerd!');
  const FLAVORS = [{
    id: 'chocolade',
    label: 'chocolade',
    color: '#8a5a3b'
  }, {
    id: 'slagroom',
    label: 'slagroom',
    color: '#fff5e6'
  }, {
    id: 'fruit',
    label: 'aardbei',
    color: '#ec6ca0'
  }, {
    id: 'mokka',
    label: 'mokka',
    color: '#3d3a35'
  }];
  const flavorColor = FLAVORS.find(f => f.id === flavor).color;
  const basePrice = 12 + (persons - 4) * 1.5;
  const price = Math.round(basePrice);
  return /*#__PURE__*/React.createElement("section", {
    style: {
      marginBottom: 56,
      background: 'var(--paper)',
      borderRadius: 20,
      padding: 36,
      display: 'grid',
      gridTemplateColumns: '1fr 1.2fr',
      gap: 40,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, eyebrow('al meer dan 50 jaar', 'var(--hema-red)'), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 280,
      height: 240,
      position: 'relative',
      display: 'flex',
      alignItems: 'flex-end',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      bottom: 0,
      left: '50%',
      transform: 'translateX(-50%)',
      width: 260,
      height: 20,
      borderRadius: '50%',
      background: 'var(--stone-200)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      width: shape === 'rond' ? 200 : 220,
      height: 130,
      background: flavorColor,
      borderRadius: shape === 'rond' ? '100px 100px 20px 20px / 50px 50px 10px 10px' : 8,
      border: flavor === 'slagroom' ? '1px solid var(--stone-200)' : 'none',
      transition: 'background .25s, width .25s, border-radius .25s',
      marginBottom: 14,
      boxShadow: '0 4px 0 rgba(0,0,0,.05)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: -10,
      left: 12,
      right: 12,
      height: 22,
      background: '#fffaf2',
      borderRadius: 999,
      borderBottom: '1px solid rgba(0,0,0,.04)'
    }
  }), [18, 60, 100, 140, 180].slice(0, shape === 'rond' ? 4 : 5).map((x, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      position: 'absolute',
      top: -16,
      left: x,
      width: 14,
      height: 14,
      background: 'var(--hema-red)',
      borderRadius: '50%',
      boxShadow: 'inset -2px -2px 0 rgba(0,0,0,.1)'
    }
  })), Array.from({
    length: Math.min(6, Math.ceil(persons / 2))
  }).map((_, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      position: 'absolute',
      bottom: '100%',
      left: 30 + i * 28,
      width: 4,
      height: 26,
      background: ['#ec6ca0', '#f5c518', '#2aa8a8', '#ed2923', '#7b51a1', '#f08d2c'][i % 6],
      borderRadius: 2
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: -6,
      left: -3,
      width: 10,
      height: 10,
      background: '#f5c518',
      borderRadius: '50% 50% 50% 0',
      transform: 'rotate(-45deg)',
      boxShadow: '0 0 8px rgba(245,197,24,.8)'
    }
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      bottom: 20,
      left: 0,
      right: 0,
      textAlign: 'center',
      color: flavor === 'slagroom' ? '#ed2923' : '#fff',
      fontSize: 14,
      fontWeight: 700,
      textTransform: 'lowercase',
      fontStyle: 'italic',
      textShadow: flavor === 'slagroom' ? 'none' : '1px 1px 0 rgba(0,0,0,.15)',
      padding: '0 18px',
      overflow: 'hidden',
      whiteSpace: 'nowrap',
      textOverflow: 'ellipsis'
    }
  }, text || '\u00a0')))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: 30,
      fontWeight: 700,
      textTransform: 'lowercase',
      letterSpacing: '-0.01em',
      margin: '0 0 6px'
    }
  }, "stel je verjaardagstaart samen"), /*#__PURE__*/React.createElement("p", {
    style: {
      color: 'var(--fg-3)',
      margin: '0 0 22px',
      fontSize: 14
    }
  }, "vandaag besteld, morgen klaar in de winkel. al vanaf \u20AC 12."), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 18
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      fontWeight: 700,
      marginBottom: 8
    }
  }, "vorm"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8
    }
  }, ['rond', 'vierkant'].map(s => /*#__PURE__*/React.createElement("button", {
    key: s,
    onClick: () => setShape(s),
    style: {
      padding: '8px 16px',
      borderRadius: 999,
      cursor: 'pointer',
      fontFamily: 'inherit',
      fontSize: 13,
      fontWeight: 600,
      textTransform: 'lowercase',
      border: shape === s ? '2px solid #14100c' : '1px solid var(--border-1)',
      background: shape === s ? '#14100c' : '#fff',
      color: shape === s ? '#fff' : 'var(--fg-1)'
    }
  }, s)))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 18
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      fontWeight: 700,
      marginBottom: 8
    }
  }, "smaak"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10,
      flexWrap: 'wrap'
    }
  }, FLAVORS.map(f => /*#__PURE__*/React.createElement("button", {
    key: f.id,
    onClick: () => setFlavor(f.id),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '6px 12px 6px 6px',
      borderRadius: 999,
      cursor: 'pointer',
      fontFamily: 'inherit',
      fontSize: 13,
      fontWeight: 600,
      textTransform: 'lowercase',
      border: flavor === f.id ? '2px solid #14100c' : '1px solid var(--border-1)',
      background: '#fff'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 24,
      height: 24,
      borderRadius: '50%',
      background: f.color,
      border: f.color === '#fff5e6' ? '1px solid var(--border-1)' : 'none'
    }
  }), f.label)))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 18
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      fontWeight: 700
    }
  }, "voor hoeveel personen?"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      color: 'var(--fg-3)'
    }
  }, /*#__PURE__*/React.createElement("strong", {
    style: {
      color: 'var(--fg-1)'
    }
  }, persons), " personen")), /*#__PURE__*/React.createElement("input", {
    type: "range",
    min: 4,
    max: 20,
    step: 2,
    value: persons,
    onChange: e => setPersons(+e.target.value),
    style: {
      width: '100%',
      accentColor: 'var(--hema-red)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      fontSize: 11,
      color: 'var(--fg-3)',
      marginTop: 2
    }
  }, /*#__PURE__*/React.createElement("span", null, "4"), /*#__PURE__*/React.createElement("span", null, "10"), /*#__PURE__*/React.createElement("span", null, "20"))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 22
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      fontWeight: 700,
      marginBottom: 8
    }
  }, "tekst op de taart"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    maxLength: 28,
    value: text,
    onChange: e => setText(e.target.value),
    placeholder: "bijv. gefeliciteerd!",
    style: {
      width: '100%'
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      padding: '14px 16px',
      background: '#fff',
      borderRadius: 12,
      border: '1px solid var(--border-1)'
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: 'var(--fg-3)',
      textTransform: 'uppercase',
      letterSpacing: '0.06em',
      fontWeight: 600
    }
  }, "totaal"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 28,
      fontWeight: 700,
      lineHeight: 1,
      fontVariantNumeric: 'tabular-nums'
    }
  }, "\u20AC\xA0", price)), /*#__PURE__*/React.createElement("button", {
    className: "btn btn--primary",
    style: {
      marginLeft: 'auto'
    }
  }, "bestel taart"))));
};

// ============================================================================
// 4. RECEPTEN VAN DE WEEK
// ============================================================================
const RecipeOfTheWeek = () => {
  const recipes = [{
    id: 1,
    title: 'pasta met zongedroogde tomaat',
    meta: '20 min · 4 personen',
    tag: 'snel klaar',
    bg: '#f5c518',
    accent: '#ed2923'
  }, {
    id: 2,
    title: 'appeltaart van oma',
    meta: '90 min · 8 personen',
    tag: 'klassieker',
    bg: '#ec6ca0',
    accent: '#7b51a1'
  }, {
    id: 3,
    title: 'broccoli soep met kaas',
    meta: '30 min · 4 personen',
    tag: 'vegetarisch',
    bg: '#6cb33e',
    accent: '#fff'
  }];
  return /*#__PURE__*/React.createElement("section", {
    style: {
      marginBottom: 56
    }
  }, sectionTitle('deze week op het menu', 'alle recepten'), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '2fr 1fr 1fr',
      gap: 14
    }
  }, recipes.map((r, i) => /*#__PURE__*/React.createElement("a", {
    key: r.id,
    href: "#",
    onClick: e => e.preventDefault(),
    style: {
      position: 'relative',
      display: 'block',
      background: r.bg,
      borderRadius: 16,
      overflow: 'hidden',
      minHeight: i === 0 ? 320 : 320,
      padding: 24,
      color: i === 2 ? '#fff' : 'var(--fg-1)',
      textDecoration: 'none',
      transition: 'transform .2s'
    },
    onMouseEnter: e => e.currentTarget.style.transform = 'translateY(-3px)',
    onMouseLeave: e => e.currentTarget.style.transform = ''
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      bottom: -40,
      right: -40,
      width: i === 0 ? 220 : 180,
      height: i === 0 ? 220 : 180,
      borderRadius: '50%',
      background: r.accent,
      opacity: .9
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      bottom: -10,
      right: -10,
      width: i === 0 ? 120 : 100,
      height: i === 0 ? 120 : 100,
      borderRadius: '50%',
      background: '#fff',
      opacity: .6
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-block',
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
      padding: '4px 10px',
      background: i === 2 ? 'rgba(255,255,255,.25)' : 'rgba(20,16,12,.08)',
      borderRadius: 999
    }
  }, r.tag), /*#__PURE__*/React.createElement("h3", {
    style: {
      fontSize: i === 0 ? 32 : 22,
      fontWeight: 700,
      lineHeight: 1.05,
      letterSpacing: '-0.02em',
      margin: '14px 0 8px',
      textTransform: 'lowercase',
      maxWidth: i === 0 ? '60%' : '100%'
    }
  }, r.title), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      fontWeight: 600,
      opacity: .85
    }
  }, r.meta), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      bottom: -250,
      left: 0,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 14,
      fontWeight: 700
    }
  }, "bekijk recept ", /*#__PURE__*/React.createElement(HemaIcon, {
    name: "arrow-right",
    size: 16
  })))))));
};

// ============================================================================
// 5. LIVE ACTIVITY TICKER — rotating social proof strip
// ============================================================================
const LiveActivity = () => {
  const events = [{
    name: 'sanne',
    city: 'utrecht',
    item: 'kaarsenset 3 stuks'
  }, {
    name: 'joost',
    city: 'rotterdam',
    item: 'badmat zacht roze'
  }, {
    name: 'fatima',
    city: 'den haag',
    item: 'theelichtjes 50 stuks'
  }, {
    name: 'mark',
    city: 'amsterdam',
    item: 'kookboek alledag'
  }, {
    name: 'lieke',
    city: 'eindhoven',
    item: 'plaid effen lichtblauw'
  }, {
    name: 'omar',
    city: 'groningen',
    item: 'puzzel 1000 stukjes'
  }];
  const [idx, setIdx] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => setIdx(i => (i + 1) % events.length), 3000);
    return () => clearInterval(id);
  }, []);
  const e = events[idx];
  return /*#__PURE__*/React.createElement("section", {
    style: {
      marginBottom: 56,
      background: '#fff',
      border: '1px solid var(--border-1)',
      borderRadius: 999,
      padding: '10px 18px',
      display: 'flex',
      alignItems: 'center',
      gap: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 8,
      height: 8,
      borderRadius: '50%',
      background: '#2f8a3e',
      boxShadow: '0 0 0 0 rgba(47,138,62,.5)',
      animation: 'hema-pulse 1.5s ease-out infinite'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      fontWeight: 700,
      color: 'var(--fg-3)',
      textTransform: 'uppercase',
      letterSpacing: '0.08em'
    }
  }, "live")), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 1,
      height: 22,
      background: 'var(--border-1)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    key: idx,
    style: {
      fontSize: 14,
      color: 'var(--fg-1)',
      overflow: 'hidden',
      animation: 'hema-fade 3s ease-out'
    }
  }, /*#__PURE__*/React.createElement("strong", {
    style: {
      fontWeight: 700
    }
  }, e.name), /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--fg-3)'
    }
  }, " uit ", e.city, " kocht zojuist "), /*#__PURE__*/React.createElement("strong", {
    style: {
      fontWeight: 700
    }
  }, e.item)), /*#__PURE__*/React.createElement("div", {
    style: {
      marginLeft: 'auto',
      display: 'flex',
      gap: 4
    }
  }, events.map((_, i) => /*#__PURE__*/React.createElement("span", {
    key: i,
    style: {
      width: i === idx ? 16 : 4,
      height: 4,
      borderRadius: 2,
      background: i === idx ? 'var(--hema-red)' : 'var(--stone-200)',
      transition: 'width .3s, background .3s'
    }
  }))), /*#__PURE__*/React.createElement("style", null, `
        @keyframes hema-pulse {
          0%   { box-shadow: 0 0 0 0 rgba(47,138,62,.5); }
          70%  { box-shadow: 0 0 0 8px rgba(47,138,62,0); }
          100% { box-shadow: 0 0 0 0 rgba(47,138,62,0); }
        }
        @keyframes hema-fade {
          0%   { opacity: 0; transform: translateY(4px); }
          15%  { opacity: 1; transform: translateY(0); }
          85%  { opacity: 1; }
          100% { opacity: 1; }
        }
      `));
};

// ============================================================================
// 6. SNELLE CATEGORIEËN — horizontal scroll mini-tiles
// ============================================================================
const QuickCategories = ({
  onNav
}) => {
  const items = [{
    label: 'rookworst',
    emoji: null,
    bg: '#ed2923',
    fg: '#fff',
    symbol: '◖◗'
  }, {
    label: 'verjaardag',
    emoji: null,
    bg: '#f5c518',
    fg: '#14100c',
    symbol: '✦'
  }, {
    label: 'pyjama’s',
    emoji: null,
    bg: '#ec6ca0',
    fg: '#fff',
    symbol: '∿'
  }, {
    label: 'school & papier',
    emoji: null,
    bg: '#2aa8a8',
    fg: '#fff',
    symbol: '▤'
  }, {
    label: 'planten',
    emoji: null,
    bg: '#6cb33e',
    fg: '#fff',
    symbol: '❦'
  }, {
    label: 'fotoboek',
    emoji: null,
    bg: '#7b51a1',
    fg: '#fff',
    symbol: '▭'
  }, {
    label: 'tompoes',
    emoji: null,
    bg: '#f08d2c',
    fg: '#fff',
    symbol: '▰'
  }, {
    label: 'sloffen',
    emoji: null,
    bg: '#4ab4e6',
    fg: '#fff',
    symbol: '◠'
  }, {
    label: 'onderbroeken',
    emoji: null,
    bg: '#1f6fb4',
    fg: '#fff',
    symbol: '◢◣'
  }, {
    label: 'snoep',
    emoji: null,
    bg: '#b9ce47',
    fg: '#14100c',
    symbol: '◍'
  }];
  return /*#__PURE__*/React.createElement("section", {
    style: {
      marginBottom: 56
    }
  }, sectionTitle('snel naar', null), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridAutoFlow: 'column',
      gridAutoColumns: 'minmax(110px, 1fr)',
      gap: 12,
      overflowX: 'auto',
      paddingBottom: 6,
      scrollbarWidth: 'none'
    }
  }, items.map(it => /*#__PURE__*/React.createElement("button", {
    key: it.label,
    onClick: () => onNav('category', it.label),
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 8,
      background: 'transparent',
      border: 'none',
      cursor: 'pointer',
      padding: 0,
      fontFamily: 'inherit'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: '100%',
      aspectRatio: '1/1',
      borderRadius: 16,
      background: it.bg,
      color: it.fg,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 36,
      fontWeight: 700,
      transition: 'transform .18s'
    },
    onMouseEnter: e => e.currentTarget.style.transform = 'scale(1.04)',
    onMouseLeave: e => e.currentTarget.style.transform = ''
  }, it.symbol), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      fontWeight: 600,
      color: 'var(--fg-1)',
      textTransform: 'lowercase'
    }
  }, it.label)))));
};

// ============================================================================
// 7. MEER HEMA LOYALTY — savings progress + perks
// ============================================================================
const MeerHemaProgress = () => {
  const [stamps, setStamps] = React.useState(7);
  const total = 10;
  const reward = {
    label: 'gratis ontbijt in het hema-restaurant',
    value: '€ 0'
  };
  return /*#__PURE__*/React.createElement("section", {
    style: {
      marginBottom: 56,
      background: '#14100c',
      color: '#fff',
      borderRadius: 20,
      overflow: 'hidden',
      display: 'grid',
      gridTemplateColumns: '1.4fr 1fr'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '32px 36px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      background: 'var(--hema-red)',
      color: '#fff',
      padding: '4px 10px',
      borderRadius: 6,
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: '0.08em',
      textTransform: 'uppercase'
    }
  }, "meer hema"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      opacity: .7
    }
  }, "ingelogd als sanne")), /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: 30,
      fontWeight: 700,
      lineHeight: 1.05,
      letterSpacing: '-0.01em',
      textTransform: 'lowercase',
      margin: '0 0 8px'
    }
  }, "nog ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#f5c518'
    }
  }, total - stamps, " stempels"), " voor ", reward.label), /*#__PURE__*/React.createElement("p", {
    style: {
      opacity: .8,
      margin: '0 0 24px',
      fontSize: 14,
      maxWidth: 460
    }
  }, "je krijgt bij elke aankoop een digitale stempel. spaar je vol? gratis ontbijt cadeau."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: `repeat(${total}, 1fr)`,
      gap: 6,
      marginBottom: 18
    }
  }, Array.from({
    length: total
  }).map((_, i) => {
    const filled = i < stamps;
    return /*#__PURE__*/React.createElement("div", {
      key: i,
      onClick: () => setStamps(i + 1),
      style: {
        aspectRatio: '1/1',
        borderRadius: '50%',
        background: filled ? 'var(--hema-red)' : 'transparent',
        border: filled ? 'none' : '1.5px dashed rgba(255,255,255,.3)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#fff',
        fontSize: 14,
        fontWeight: 700,
        cursor: 'pointer',
        transition: 'all .2s'
      }
    }, filled && /*#__PURE__*/React.createElement(HemaIcon, {
      name: "check",
      size: 14,
      color: "#fff"
    }));
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn--primary"
  }, "scan je kassabon"), /*#__PURE__*/React.createElement("button", {
    style: {
      padding: '12px 22px',
      borderRadius: 999,
      cursor: 'pointer',
      background: 'transparent',
      color: '#fff',
      border: '1.5px solid rgba(255,255,255,.3)',
      fontFamily: 'inherit',
      fontWeight: 600,
      fontSize: 16,
      textTransform: 'lowercase'
    }
  }, "jouw voordelen"))), /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'linear-gradient(135deg, var(--hema-red) 0%, #b41c14 100%)',
      padding: '32px 28px',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      gap: 14
    }
  }, [{
    icon: 'check',
    text: '10% korting op je verjaardag'
  }, {
    icon: 'check',
    text: 'gratis verzending vanaf € 20'
  }, {
    icon: 'check',
    text: 'maandelijks een spaaractie'
  }, {
    icon: 'check',
    text: 'als eerste bij nieuwe collecties'
  }].map((perk, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 26,
      height: 26,
      borderRadius: '50%',
      background: 'rgba(255,255,255,.18)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: perk.icon,
    size: 14
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 14,
      fontWeight: 500
    }
  }, perk.text)))));
};

// ---- export ---------------------------------------------------------------
window.HemaHomeSections = {
  FlashDeals,
  BestsellersTop10,
  CakeConfigurator,
  RecipeOfTheWeek,
  LiveActivity,
  QuickCategories,
  MeerHemaProgress
};
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web/HomeSections.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web/Icon.jsx
try { (() => {
// Icon.jsx — Lucide-style 24px line icons. 2px stroke, rounded.
const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
};
const Icon = ({
  name,
  size = 22,
  color
}) => {
  const props = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    style: {
      color,
      flex: '0 0 auto'
    },
    ...STROKE
  };
  switch (name) {
    case 'search':
      return /*#__PURE__*/React.createElement("svg", props, /*#__PURE__*/React.createElement("circle", {
        cx: "11",
        cy: "11",
        r: "7"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M21 21l-4.3-4.3"
      }));
    case 'user':
      return /*#__PURE__*/React.createElement("svg", props, /*#__PURE__*/React.createElement("path", {
        d: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "7",
        r: "4"
      }));
    case 'heart':
      return /*#__PURE__*/React.createElement("svg", props, /*#__PURE__*/React.createElement("path", {
        d: "M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z"
      }));
    case 'cart':
      return /*#__PURE__*/React.createElement("svg", props, /*#__PURE__*/React.createElement("circle", {
        cx: "9",
        cy: "21",
        r: "1"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "20",
        cy: "21",
        r: "1"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"
      }));
    case 'menu':
      return /*#__PURE__*/React.createElement("svg", props, /*#__PURE__*/React.createElement("path", {
        d: "M3 6h18M3 12h18M3 18h18"
      }));
    case 'close':
      return /*#__PURE__*/React.createElement("svg", props, /*#__PURE__*/React.createElement("path", {
        d: "M18 6 6 18M6 6l12 12"
      }));
    case 'arrow-left':
      return /*#__PURE__*/React.createElement("svg", props, /*#__PURE__*/React.createElement("path", {
        d: "M19 12H5M12 19l-7-7 7-7"
      }));
    case 'arrow-right':
      return /*#__PURE__*/React.createElement("svg", props, /*#__PURE__*/React.createElement("path", {
        d: "M5 12h14M12 5l7 7-7 7"
      }));
    case 'chevron-down':
      return /*#__PURE__*/React.createElement("svg", props, /*#__PURE__*/React.createElement("path", {
        d: "m6 9 6 6 6-6"
      }));
    case 'minus':
      return /*#__PURE__*/React.createElement("svg", props, /*#__PURE__*/React.createElement("path", {
        d: "M5 12h14"
      }));
    case 'plus':
      return /*#__PURE__*/React.createElement("svg", props, /*#__PURE__*/React.createElement("path", {
        d: "M12 5v14M5 12h14"
      }));
    case 'pin':
      return /*#__PURE__*/React.createElement("svg", props, /*#__PURE__*/React.createElement("path", {
        d: "M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0Z"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "10",
        r: "3"
      }));
    case 'truck':
      return /*#__PURE__*/React.createElement("svg", props, /*#__PURE__*/React.createElement("rect", {
        x: "1",
        y: "3",
        width: "15",
        height: "13",
        rx: "2"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M16 8h4l3 3v5h-7"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "6",
        cy: "19",
        r: "2"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "18",
        cy: "19",
        r: "2"
      }));
    case 'return':
      return /*#__PURE__*/React.createElement("svg", props, /*#__PURE__*/React.createElement("path", {
        d: "M3 12a9 9 0 0 1 9-9 9 9 0 0 1 7 3.3L21 8"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M21 3v5h-5"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M21 12a9 9 0 0 1-9 9 9 9 0 0 1-7-3.3L3 16"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M3 21v-5h5"
      }));
    case 'check':
      return /*#__PURE__*/React.createElement("svg", props, /*#__PURE__*/React.createElement("path", {
        d: "m5 12 5 5 9-11"
      }));
    case 'filter':
      return /*#__PURE__*/React.createElement("svg", props, /*#__PURE__*/React.createElement("path", {
        d: "M3 6h18M6 12h12M10 18h4"
      }));
    case 'star':
      return /*#__PURE__*/React.createElement("svg", props, /*#__PURE__*/React.createElement("path", {
        d: "m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1L12 2Z"
      }));
    default:
      return null;
  }
};
window.HemaIcon = Icon;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web/Icon.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web/PDPApp.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
// PDPApp.jsx — root for the product details page.

const {
  PDPHighlights,
  PDPDescription,
  PDPSpecs,
  PDPReviews,
  PDPFaq,
  PDPBundle,
  PDPCompare,
  PDPRelated
} = window.PDPSections;
const Breadcrumb = ({
  trail,
  onNav
}) => /*#__PURE__*/React.createElement("nav", {
  style: {
    fontSize: 13,
    color: 'var(--fg-3)',
    margin: '22px 0 18px',
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
    alignItems: 'center'
  }
}, trail.map((t, i) => /*#__PURE__*/React.createElement(React.Fragment, {
  key: t.label
}, t.to ? /*#__PURE__*/React.createElement("a", {
  href: "#",
  onClick: e => {
    e.preventDefault();
    onNav && onNav(t.to);
  },
  style: {
    color: 'var(--fg-3)'
  }
}, t.label) : /*#__PURE__*/React.createElement("span", {
  style: {
    color: 'var(--fg-1)'
  }
}, t.label), i < trail.length - 1 && /*#__PURE__*/React.createElement("span", {
  style: {
    color: 'var(--border-2)'
  }
}, "\u203A"))));
const SectionNav = () => {
  const items = [['#beschrijving', 'beschrijving'], ['#specs', 'specificaties'], ['#reviews', 'reviews (1.243)'], ['#faq', 'vragen']];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'sticky',
      top: 132,
      zIndex: 30,
      background: 'rgba(255,255,255,.92)',
      backdropFilter: 'blur(8px)',
      borderTop: '1px solid var(--border-1)',
      borderBottom: '1px solid var(--border-1)',
      margin: '20px 0 32px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "pdp-wrap",
    style: {
      display: 'flex',
      gap: 22,
      alignItems: 'center',
      padding: '14px 24px',
      overflowX: 'auto'
    }
  }, items.map(([h, l]) => /*#__PURE__*/React.createElement("a", {
    key: h,
    href: h,
    style: {
      fontSize: 14,
      fontWeight: 600,
      color: 'var(--fg-1)',
      textDecoration: 'none',
      whiteSpace: 'nowrap'
    }
  }, l)), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("a", {
    href: "#top",
    style: {
      fontSize: 13,
      color: 'var(--fg-3)',
      textDecoration: 'none',
      whiteSpace: 'nowrap'
    }
  }, "\u2191 terug naar boven")));
};
const App = () => {
  const [toast, setToast] = React.useState(null);
  const [cart, setCart] = React.useState([]);
  const addToCart = (p, qty, color) => {
    setCart(c => [...c, {
      id: p.id,
      qty
    }]);
    setToast({
      msg: `${p.name} toegevoegd aan je mandje`,
      sub: `kleur: ${color} · aantal: ${qty}`
    });
  };
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(HemaHeader, {
    onNav: () => {},
    cartCount: cart.reduce((s, i) => s + i.qty, 0)
  }), /*#__PURE__*/React.createElement("div", {
    id: "top",
    className: "pdp-wrap",
    style: {
      paddingBottom: 24
    }
  }, /*#__PURE__*/React.createElement(Breadcrumb, {
    trail: [{
      label: 'home',
      to: 'home'
    }, {
      label: 'wonen',
      to: 'category'
    }, {
      label: 'huishoudelijke apparaten',
      to: 'category'
    }, {
      label: 'kledingstomers'
    }]
  }), /*#__PURE__*/React.createElement("section", {
    className: "pdp-main",
    style: {
      display: 'grid',
      gridTemplateColumns: '1.25fr 1fr',
      gap: 48,
      alignItems: 'start'
    }
  }, /*#__PURE__*/React.createElement(PDPGallery, null), /*#__PURE__*/React.createElement(PDPBuyRail, {
    onAdd: addToCart
  })), /*#__PURE__*/React.createElement(PDPHighlights, null), /*#__PURE__*/React.createElement(SectionNav, null), /*#__PURE__*/React.createElement(PDPDescription, null), /*#__PURE__*/React.createElement(PDPSpecs, null), /*#__PURE__*/React.createElement(PDPReviews, null), /*#__PURE__*/React.createElement(PDPFaq, null), /*#__PURE__*/React.createElement(PDPBundle, null), /*#__PURE__*/React.createElement(PDPCompare, null), /*#__PURE__*/React.createElement(PDPRelated, {
    title: "ook handig in huis",
    onNav: () => {},
    slice: [0, 5]
  }), /*#__PURE__*/React.createElement(PDPRelated, {
    title: "recent bekeken",
    onNav: () => {},
    slice: [5, 10]
  })), /*#__PURE__*/React.createElement(HemaFooter, null), toast && /*#__PURE__*/React.createElement(HemaToast, _extends({}, toast, {
    onDismiss: () => setToast(null)
  })));
};
ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(App, null));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web/PDPApp.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web/PDPBuyRail.jsx
try { (() => {
// PDPBuyRail.jsx — right-side info + price + variants + CTA + trust block.

const PRODUCT = {
  id: 'h-steam-1500',
  name: 'kledingstomer 1500w',
  sub: 'snel ontkreuken in 20 seconden · 300 ml watertank',
  brand: 'hema',
  sku: '81.16.0142',
  price: 25,
  was: 35,
  rating: 4.7,
  reviews: 1243,
  sold: '5.000+',
  colors: [{
    id: 'zwart',
    label: 'zwart',
    hex: '#1a1a1a',
    stock: 'op voorraad'
  }, {
    id: 'wit',
    label: 'wit',
    hex: '#f3efe8',
    stock: 'op voorraad'
  }, {
    id: 'mint',
    label: 'mintgroen',
    hex: '#b9ce47',
    stock: 'nog 4 op voorraad'
  }],
  highlights: ['klaar in 20 seconden — geen wachten meer', 'voor alle stoffen, ook zijde en katoen', '300 ml watertank · genoeg voor ± 12 minuten stoom', 'lichtgewicht (0,8 kg) en handig op reis']
};
window.HEMA_PDP_PRODUCT = PRODUCT;
const Stars = ({
  value = 0,
  size = 16
}) => {
  // half-star approximation via opacity layering
  const full = Math.floor(value);
  const half = value - full >= 0.4 ? 1 : 0;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 1
    }
  }, [0, 1, 2, 3, 4].map(i => /*#__PURE__*/React.createElement(HemaIcon, {
    key: i,
    name: "star",
    size: size,
    color: i < full ? '#f5c518' : i === full && half ? '#f5c518' : '#e6e2dc'
  })));
};
window.PDPStars = Stars;
const Pill = ({
  icon,
  label,
  sub,
  tone
}) => /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    fontSize: 14,
    color: 'var(--fg-2)',
    lineHeight: 1.35
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    width: 32,
    height: 32,
    borderRadius: 999,
    background: 'var(--bg-subtle)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: tone || 'var(--hema-red)',
    flex: '0 0 auto'
  }
}, icon), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("div", {
  style: {
    fontWeight: 600,
    color: 'var(--fg-1)'
  }
}, label), sub && /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: 12,
    color: 'var(--fg-3)'
  }
}, sub)));
const PDPBuyRail = ({
  onAdd
}) => {
  const p = PRODUCT;
  const [color, setColor] = React.useState('zwart');
  const [qty, setQty] = React.useState(1);
  const [fulfil, setFulfil] = React.useState('home'); // home | store
  const activeColor = p.colors.find(c => c.id === color);
  const savings = p.was - p.price;
  const savingsPct = Math.round(savings / p.was * 100);

  // delivery date — tomorrow, in Dutch
  const days = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];
  const months = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const deliverLabel = `${days[tomorrow.getDay()]} ${tomorrow.getDate()} ${months[tomorrow.getMonth()]}`;
  return /*#__PURE__*/React.createElement("div", {
    className: "pdp-rail",
    style: {
      position: 'sticky',
      top: 132,
      alignSelf: 'start'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      fontWeight: 700,
      letterSpacing: '.06em',
      textTransform: 'uppercase',
      color: 'var(--hema-red)',
      marginBottom: 6
    }
  }, p.brand, " \xB7 huismerk"), /*#__PURE__*/React.createElement("h1", {
    style: {
      fontSize: 34,
      fontWeight: 700,
      lineHeight: 1.05,
      letterSpacing: '-0.015em',
      textTransform: 'lowercase',
      margin: '0 0 8px'
    }
  }, p.name), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 16,
      color: 'var(--fg-2)',
      margin: '0 0 14px',
      lineHeight: 1.4
    }
  }, p.sub), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      marginBottom: 20,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("a", {
    href: "#reviews",
    className: "pdp-link",
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement(Stars, {
    value: p.rating
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 700
    }
  }, p.rating.toString().replace('.', ',')), /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--fg-3)',
      fontWeight: 400,
      textDecoration: 'none'
    }
  }, "\xB7 ", p.reviews.toLocaleString('nl-NL'), " reviews")), /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--border-2)'
    }
  }, "|"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 14,
      color: 'var(--fg-2)'
    }
  }, p.sold, " keer gekocht")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-end',
      gap: 12,
      margin: '0 0 4px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 40,
      fontWeight: 700,
      lineHeight: 1,
      color: 'var(--hema-red)',
      fontVariantNumeric: 'tabular-nums'
    }
  }, "\u20AC\xA0", p.price), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 18,
      color: 'var(--fg-3)',
      textDecoration: 'line-through',
      fontVariantNumeric: 'tabular-nums',
      marginBottom: 4
    }
  }, "\u20AC\xA0", p.was), /*#__PURE__*/React.createElement("span", {
    style: {
      background: 'var(--hema-red)',
      color: '#fff',
      fontSize: 12,
      fontWeight: 700,
      padding: '4px 8px',
      borderRadius: 4,
      marginBottom: 6
    }
  }, "\u2212 ", savingsPct, "%")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: 'var(--fg-3)',
      marginBottom: 4
    }
  }, "incl. btw \xB7 adviesprijs \u20AC ", p.was), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 13,
      color: 'var(--success)',
      fontWeight: 600,
      marginBottom: 24
    }
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: "check",
    size: 14
  }), " jij bespaart \u20AC ", savings, " \xB7 actie loopt nog 3 dagen"), /*#__PURE__*/React.createElement("hr", {
    className: "pdp-hr"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      margin: '20px 0'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      fontWeight: 700
    }
  }, "kleur: ", /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 400
    }
  }, activeColor.label)), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: 'var(--fg-3)'
    }
  }, activeColor.stock)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10,
      flexWrap: 'wrap'
    }
  }, p.colors.map(c => /*#__PURE__*/React.createElement("button", {
    key: c.id,
    onClick: () => setColor(c.id),
    title: c.label,
    style: {
      width: 64,
      height: 64,
      borderRadius: 8,
      padding: 4,
      cursor: 'pointer',
      background: '#fff',
      border: color === c.id ? '2px solid var(--fg-1)' : '1px solid var(--border-1)',
      transition: 'border-color .15s var(--ease-standard)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: '100%',
      height: '100%',
      borderRadius: 4,
      background: c.hex,
      border: c.id === 'wit' ? '1px solid var(--border-1)' : 'none'
    }
  }))))), /*#__PURE__*/React.createElement("div", {
    style: {
      margin: '20px 0'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      fontWeight: 700,
      marginBottom: 10
    }
  }, "hoe wil je het ontvangen?"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 8
    }
  }, [{
    id: 'home',
    label: 'thuisbezorgd',
    sub: `morgen ${deliverLabel}`,
    icon: 'truck'
  }, {
    id: 'store',
    label: 'ophalen in winkel',
    sub: 'gratis · vanaf vandaag',
    icon: 'pin'
  }].map(opt => /*#__PURE__*/React.createElement("button", {
    key: opt.id,
    onClick: () => setFulfil(opt.id),
    style: {
      all: 'unset',
      cursor: 'pointer',
      padding: '12px 14px',
      borderRadius: 8,
      border: fulfil === opt.id ? '2px solid var(--fg-1)' : '1px solid var(--border-1)',
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      background: '#fff'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      fontWeight: 700,
      fontSize: 14
    }
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: opt.icon,
    size: 16,
    color: "var(--hema-red)"
  }), " ", opt.label), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: 'var(--fg-3)'
    }
  }, opt.sub))))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 12,
      alignItems: 'stretch',
      margin: '20px 0 14px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      border: '1px solid var(--border-1)',
      borderRadius: 999
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setQty(Math.max(1, qty - 1)),
    "aria-label": "minder",
    style: {
      width: 44,
      height: 44,
      border: 'none',
      background: 'transparent',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: "minus",
    size: 16
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      minWidth: 28,
      textAlign: 'center',
      fontWeight: 700,
      fontVariantNumeric: 'tabular-nums'
    }
  }, qty), /*#__PURE__*/React.createElement("button", {
    onClick: () => setQty(qty + 1),
    "aria-label": "meer",
    style: {
      width: 44,
      height: 44,
      border: 'none',
      background: 'transparent',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: "plus",
    size: 16
  }))), /*#__PURE__*/React.createElement("button", {
    className: "btn btn--primary btn--lg",
    style: {
      flex: 1
    },
    onClick: () => onAdd && onAdd(p, qty, color)
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: "cart",
    size: 18
  }), " in winkelmandje \xB7 \u20AC ", p.price * qty)), /*#__PURE__*/React.createElement("button", {
    className: "btn btn--outline",
    style: {
      width: '100%',
      marginBottom: 22
    }
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: "heart",
    size: 16
  }), " bewaar voor later"), /*#__PURE__*/React.createElement("hr", {
    className: "pdp-hr"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
      padding: '22px 0'
    }
  }, /*#__PURE__*/React.createElement(Pill, {
    icon: /*#__PURE__*/React.createElement(HemaIcon, {
      name: "truck",
      size: 18
    }),
    label: `morgen bij je in huis · ${deliverLabel}`,
    sub: "bestel voor 22:00, gratis vanaf \u20AC 30"
  }), /*#__PURE__*/React.createElement(Pill, {
    icon: /*#__PURE__*/React.createElement(HemaIcon, {
      name: "return",
      size: 18
    }),
    label: "60 dagen retour",
    sub: "gratis in elke hema-winkel"
  }), /*#__PURE__*/React.createElement(Pill, {
    icon: /*#__PURE__*/React.createElement(HemaIcon, {
      name: "pin",
      size: 18
    }),
    label: "op voorraad in 12 winkels in de buurt",
    sub: /*#__PURE__*/React.createElement("a", {
      href: "#",
      className: "pdp-link",
      style: {
        fontSize: 12
      }
    }, "bekijk winkels \u2192")
  }), /*#__PURE__*/React.createElement(Pill, {
    icon: /*#__PURE__*/React.createElement(HemaIcon, {
      name: "check",
      size: 18
    }),
    label: "2 jaar hema-garantie",
    sub: "ontwerp en productie in eigen huis"
  })), /*#__PURE__*/React.createElement("hr", {
    className: "pdp-hr"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '16px 0 4px',
      fontSize: 13,
      color: 'var(--fg-2)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      background: 'var(--stone-50)',
      padding: '4px 8px',
      borderRadius: 4,
      fontWeight: 700,
      fontSize: 12
    }
  }, "achteraf betalen"), "of in 3\xD7 \u20AC ", (p.price / 3).toFixed(2).replace('.', ','), " \u2014 geen kosten"), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 14,
      fontSize: 11,
      color: 'var(--fg-3)',
      fontFamily: 'var(--font-mono)'
    }
  }, "artikelnummer \xB7 ", p.sku));
};
window.PDPBuyRail = PDPBuyRail;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web/PDPBuyRail.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web/PDPGallery.jsx
try { (() => {
// PDPGallery.jsx — vertical thumbs + large image + zoom hint + tags overlay
// All photos are stylised stripe placeholders with monospace captions —
// swap in real product photography in production.

const PDPPhoto = ({
  tag
}) => /*#__PURE__*/React.createElement("div", {
  className: "pdp-photo"
}, /*#__PURE__*/React.createElement("div", {
  style: {
    width: '46%',
    aspectRatio: '1/1',
    borderRadius: 12,
    background: 'linear-gradient(160deg, #fff, #f5f3ee)',
    boxShadow: '0 1px 3px rgba(20,16,12,.06)',
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
    padding: 18
  }
}, /*#__PURE__*/React.createElement("span", {
  className: "pdp-photo__tag"
}, tag)));
const PDPGallery = ({
  product,
  activeColor
}) => {
  const [active, setActive] = React.useState(0);
  const shots = [{
    tag: 'productfoto · vooraanzicht'
  }, {
    tag: 'in gebruik · op overhemd'
  }, {
    tag: 'detail · stoomkop'
  }, {
    tag: 'detail · 300 ml watertank'
  }, {
    tag: 'inhoud verpakking'
  }, {
    tag: 'maatvoering · 25 × 13 × 10 cm'
  }];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '88px 1fr',
      gap: 14
    },
    className: "pdp-side-col"
  }, /*#__PURE__*/React.createElement("div", {
    className: "pdp-thumbs",
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 10
    }
  }, shots.map((s, i) => /*#__PURE__*/React.createElement("button", {
    key: i,
    onClick: () => setActive(i),
    "aria-label": s.tag,
    style: {
      all: 'unset',
      cursor: 'pointer',
      width: 88,
      height: 88,
      borderRadius: 8,
      background: 'var(--bg-subtle)',
      border: i === active ? '2px solid var(--fg-1)' : '1px solid var(--border-1)',
      padding: 6,
      boxSizing: 'border-box',
      transition: 'border-color .15s var(--ease-standard)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: '100%',
      height: '100%',
      borderRadius: 4,
      background: 'linear-gradient(160deg, #fff, #ecebe5)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 10,
      color: 'var(--fg-3)'
    }
  }, String(i + 1).padStart(2, '0'))))), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 88,
      height: 88,
      borderRadius: 8,
      border: '1px dashed var(--border-2)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      color: 'var(--fg-3)'
    }
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: "plus",
    size: 16
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      marginTop: 4
    }
  }, "video"))), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      aspectRatio: '1/1',
      borderRadius: 16,
      overflow: 'hidden',
      background: 'var(--bg-subtle)',
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement(PDPPhoto, {
    tag: shots[active].tag
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 16,
      left: 16,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      alignItems: 'flex-start'
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "badge badge--red",
    style: {
      padding: '5px 10px',
      fontSize: 12
    }
  }, "nieuw"), /*#__PURE__*/React.createElement("span", {
    style: {
      background: '#fff',
      color: 'var(--fg-1)',
      fontSize: 12,
      fontWeight: 600,
      padding: '5px 10px',
      borderRadius: 999,
      border: '1px solid var(--border-1)'
    }
  }, "\u2212 \u20AC 10")), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 16,
      right: 16,
      display: 'flex',
      flexDirection: 'column',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    "aria-label": "opslaan",
    title: "opslaan op favorieten",
    style: {
      width: 40,
      height: 40,
      borderRadius: 999,
      background: '#fff',
      border: '1px solid var(--border-1)',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: "heart",
    size: 18
  })), /*#__PURE__*/React.createElement("button", {
    "aria-label": "delen",
    title: "delen",
    style: {
      width: 40,
      height: 40,
      borderRadius: 999,
      background: '#fff',
      border: '1px solid var(--border-1)',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: "18",
    height: "18",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M16 6l-4-4-4 4"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M12 2v13"
  })))), /*#__PURE__*/React.createElement("div", {
    className: "pdp-zoom-hint"
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: "search",
    size: 12
  }), " klik om te vergroten"), /*#__PURE__*/React.createElement("button", {
    "aria-label": "vorige",
    onClick: () => setActive((active - 1 + shots.length) % shots.length),
    style: {
      position: 'absolute',
      left: 14,
      top: '50%',
      transform: 'translateY(-50%)',
      width: 40,
      height: 40,
      borderRadius: 999,
      background: '#fff',
      border: '1px solid var(--border-1)',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: "arrow-left",
    size: 18
  })), /*#__PURE__*/React.createElement("button", {
    "aria-label": "volgende",
    onClick: () => setActive((active + 1) % shots.length),
    style: {
      position: 'absolute',
      right: 14,
      top: '50%',
      transform: 'translateY(-50%)',
      width: 40,
      height: 40,
      borderRadius: 999,
      background: '#fff',
      border: '1px solid var(--border-1)',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: "arrow-right",
    size: 18
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      left: 14,
      bottom: 14,
      background: 'rgba(20,16,12,.78)',
      color: '#fff',
      fontSize: 12,
      fontWeight: 600,
      fontVariantNumeric: 'tabular-nums',
      padding: '4px 10px',
      borderRadius: 999
    }
  }, active + 1, " / ", shots.length)), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 12,
      padding: '12px 16px',
      background: 'var(--bg-subtle)',
      borderRadius: 8,
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 12,
      flexWrap: 'wrap',
      fontSize: 13,
      color: 'var(--fg-2)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: "check",
    size: 14,
    color: "var(--success)"
  }), " echt-mensen-fotografie, geen 3d render"), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: "check",
    size: 14,
    color: "var(--success)"
  }), " alle reviews van geverifieerde kopers"))));
};
window.PDPGallery = PDPGallery;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web/PDPGallery.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web/PDPSections.jsx
try { (() => {
// PDPSections.jsx — everything below the fold:
//   highlights · description · in-the-box · specs · reviews · FAQ
//   samen gekocht · vergelijkbare producten · recent bekeken

const {
  PRODUCTS: WEB_PRODUCTS_ALL
} = window.HEMA_DATA;
const Stars = window.PDPStars;

/* ---------- 1. "in 4 punten" ---------- */
const PDPHighlights = () => {
  const items = [{
    icon: /*#__PURE__*/React.createElement("svg", {
      width: "28",
      height: "28",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "2",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }, /*#__PURE__*/React.createElement("circle", {
      cx: "12",
      cy: "12",
      r: "9"
    }), /*#__PURE__*/React.createElement("path", {
      d: "M12 7v5l3 2"
    })),
    title: '20 sec opwarmen',
    body: 'klaar voor je het overhemd uit de kast hebt.'
  }, {
    icon: /*#__PURE__*/React.createElement("svg", {
      width: "28",
      height: "28",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "2",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }, /*#__PURE__*/React.createElement("path", {
      d: "M12 2c-1 4-5 6-5 11a5 5 0 0 0 10 0c0-5-4-7-5-11Z"
    })),
    title: '300 ml watertank',
    body: '±12 minuten stoom — afneembaar om bij te vullen.'
  }, {
    icon: /*#__PURE__*/React.createElement("svg", {
      width: "28",
      height: "28",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "2",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }, /*#__PURE__*/React.createElement("path", {
      d: "M3 7h18l-2 14H5L3 7Z"
    }), /*#__PURE__*/React.createElement("path", {
      d: "M8 7V5a4 4 0 0 1 8 0v2"
    })),
    title: 'voor alle stoffen',
    body: 'katoen, zijde, linnen, polyester — gewoon stomen.'
  }, {
    icon: /*#__PURE__*/React.createElement("svg", {
      width: "28",
      height: "28",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "2",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }, /*#__PURE__*/React.createElement("path", {
      d: "M3 7h13l4 4v6H3z"
    }), /*#__PURE__*/React.createElement("circle", {
      cx: "7",
      cy: "17",
      r: "2"
    }), /*#__PURE__*/React.createElement("circle", {
      cx: "17",
      cy: "17",
      r: "2"
    })),
    title: 'handig op reis',
    body: '0,8 kg en past in elke koffer.'
  }];
  return /*#__PURE__*/React.createElement("section", {
    style: {
      margin: '56px 0 40px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(4, 1fr)',
      gap: 14
    }
  }, items.map((it, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      padding: '24px 22px',
      background: 'var(--bg-subtle)',
      borderRadius: 12,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      minHeight: 156
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--hema-red)'
    }
  }, it.icon), /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 700,
      fontSize: 17,
      marginTop: 6
    }
  }, it.title), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      color: 'var(--fg-2)',
      lineHeight: 1.45
    }
  }, it.body)))));
};

/* ---------- 2. description + in-the-box ---------- */
const PDPDescription = () => /*#__PURE__*/React.createElement("section", {
  id: "beschrijving",
  style: {
    display: 'grid',
    gridTemplateColumns: '1.4fr 1fr',
    gap: 56,
    margin: '12px 0 56px'
  }
}, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h2", {
  style: {
    fontSize: 28,
    fontWeight: 700,
    textTransform: 'lowercase',
    letterSpacing: '-0.01em',
    margin: '0 0 16px'
  }
}, "even snel ontkreuken, geen strijkplank nodig"), /*#__PURE__*/React.createElement("p", {
  style: {
    fontSize: 17,
    color: 'var(--fg-2)',
    lineHeight: 1.55,
    margin: '0 0 14px'
  }
}, "Sommige dingen mogen gewoon makkelijk zijn. Een handige stomer die in 20 seconden klaar is, het kledingstuk op de hanger laat hangen en kreuken eruit blaast zoals een f\xF6hn een kapsel doet \u2014 meer hoef je niet te willen op een doordeweekse ochtend."), /*#__PURE__*/React.createElement("p", {
  style: {
    fontSize: 17,
    color: 'var(--fg-2)',
    lineHeight: 1.55,
    margin: '0 0 14px'
  }
}, "Werkt op alle stoffen, ook op zijde en wol. De 300\xA0ml watertank is afneembaar, dus je vult 'm zo bij onder de kraan. Veilig, want hij gaat na 8 minuten zonder gebruik vanzelf uit. En lekker licht \u2014 0,8\xA0kg, ook prima mee op reis."), /*#__PURE__*/React.createElement("p", {
  style: {
    fontSize: 17,
    color: 'var(--fg-2)',
    lineHeight: 1.55,
    margin: '0 0 22px'
  }
}, "Gemaakt in onze eigen werkplaats, getest in onze eigen kantoren. Voor als je net dat extra strakke overhemd nodig hebt, zonder gedoe."), /*#__PURE__*/React.createElement("h3", {
  style: {
    fontSize: 18,
    fontWeight: 700,
    textTransform: 'lowercase',
    margin: '24px 0 12px'
  }
}, "wat je krijgt"), /*#__PURE__*/React.createElement("ul", {
  className: "pdp-dot-list"
}, /*#__PURE__*/React.createElement("li", null, "krachtige 1500w stoomkop met 25 g/min stoomafgifte"), /*#__PURE__*/React.createElement("li", null, "afneembare watertank van 300 ml"), /*#__PURE__*/React.createElement("li", null, "automatisch uit na 8 minuten \u2014 veilig om weg te leggen"), /*#__PURE__*/React.createElement("li", null, "kindslot bij 3 sec ingedrukt houden van de aan/uit-knop"), /*#__PURE__*/React.createElement("li", null, "extra zachte borstelopzet voor wol en zijde"), /*#__PURE__*/React.createElement("li", null, "2,5\xA0m snoer \xB7 past achter elke kast"))), /*#__PURE__*/React.createElement("aside", {
  style: {
    background: '#fff',
    border: '1px solid var(--border-1)',
    borderRadius: 12,
    padding: 24,
    height: 'fit-content'
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '.06em',
    textTransform: 'uppercase',
    color: 'var(--fg-3)',
    marginBottom: 10
  }
}, "in de doos"), /*#__PURE__*/React.createElement("h3", {
  style: {
    fontSize: 22,
    fontWeight: 700,
    textTransform: 'lowercase',
    margin: '0 0 16px'
  }
}, "5 onderdelen, netjes verpakt"), /*#__PURE__*/React.createElement("ol", {
  style: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 12
  }
}, [['stoomapparaat', '1500 w, 25 g/min'], ['afneembare watertank', '300 ml'], ['maatbeker', '50 ml'], ['borstelopzet voor stoffen', 'wol, zijde, linnen'], ['handleiding', 'nl, en, de, fr']].map(([k, v], i) => /*#__PURE__*/React.createElement("li", {
  key: k,
  style: {
    display: 'flex',
    alignItems: 'center',
    gap: 12
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    width: 28,
    height: 28,
    borderRadius: 999,
    background: 'var(--bg-subtle)',
    color: 'var(--fg-1)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 700,
    fontSize: 13,
    flex: '0 0 auto',
    fontVariantNumeric: 'tabular-nums'
  }
}, i + 1), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    justifyContent: 'space-between',
    flex: 1,
    alignItems: 'baseline',
    gap: 8
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    fontWeight: 600
  }
}, k), /*#__PURE__*/React.createElement("span", {
  style: {
    fontSize: 12,
    color: 'var(--fg-3)'
  }
}, v))))), /*#__PURE__*/React.createElement("div", {
  style: {
    marginTop: 20,
    padding: '12px 14px',
    background: 'var(--bg-subtle)',
    borderRadius: 8,
    fontSize: 13,
    color: 'var(--fg-2)',
    lineHeight: 1.45
  }
}, "verpakking is fsc-papier \xB7 100% recyclebaar. geen piepschuim, geen folie.")));

/* ---------- 3. specs table + collapsible rows ---------- */
const PDPSpecs = () => {
  const SPECS = [['vermogen', '1500 w'], ['stoomafgifte', '25 g/min'], ['opwarmtijd', '20 seconden'], ['inhoud watertank', '300 ml'], ['gewicht', '0,8 kg'], ['snoerlengte', '2,5 m'], ['afmetingen', '25 × 13 × 10 cm'], ['veiligheid', 'automatisch uit · kindslot'], ['materiaal', 'abs-kunststof, rvs stoomkop'], ['garantie', '2 jaar hema']];
  return /*#__PURE__*/React.createElement("section", {
    id: "specs",
    style: {
      margin: '0 0 56px'
    }
  }, /*#__PURE__*/React.createElement("details", {
    className: "pdp-row",
    open: true
  }, /*#__PURE__*/React.createElement("summary", null, /*#__PURE__*/React.createElement("span", null, "specificaties"), /*#__PURE__*/React.createElement("span", {
    className: "pdp-chev"
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: "chevron-down",
    size: 18
  }))), /*#__PURE__*/React.createElement("div", {
    className: "pdp-row-body"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      columnGap: 56,
      rowGap: 0
    }
  }, SPECS.map(([k, v], i) => /*#__PURE__*/React.createElement("div", {
    key: k,
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      padding: '12px 0',
      borderTop: i < 2 ? 'none' : '1px solid var(--border-1)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--fg-3)'
    }
  }, k), /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--fg-1)',
      fontWeight: 600
    }
  }, v)))))), /*#__PURE__*/React.createElement("details", {
    className: "pdp-row"
  }, /*#__PURE__*/React.createElement("summary", null, /*#__PURE__*/React.createElement("span", null, "onderhoud & gebruik"), /*#__PURE__*/React.createElement("span", {
    className: "pdp-chev"
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: "chevron-down",
    size: 18
  }))), /*#__PURE__*/React.createElement("div", {
    className: "pdp-row-body"
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      margin: '0 0 10px'
    }
  }, "Gebruik gewoon kraanwater. In gebieden met heel hard water raden we aan om de tank elke maand te ontkalken met een scheutje natuurazijn. Stoom altijd verticaal, van boven naar beneden, en houd het mondstuk een paar centimeter van de stof."), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0
    }
  }, "Niet gebruiken op kleding die je nog draagt. Hete stoom, dus oppassen met je vingers \u2014 voor de zekerheid zit er een kindslot op."))), /*#__PURE__*/React.createElement("details", {
    className: "pdp-row"
  }, /*#__PURE__*/React.createElement("summary", null, /*#__PURE__*/React.createElement("span", null, "duurzaamheid"), /*#__PURE__*/React.createElement("span", {
    className: "pdp-chev"
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: "chevron-down",
    size: 18
  }))), /*#__PURE__*/React.createElement("div", {
    className: "pdp-row-body"
  }, /*#__PURE__*/React.createElement("ul", {
    className: "pdp-dot-list"
  }, /*#__PURE__*/React.createElement("li", null, "repareerbaar \u2014 onderdelen tot 7 jaar na aankoop beschikbaar in hema-winkels"), /*#__PURE__*/React.createElement("li", null, "verpakking 100% fsc-papier, geen plastic blister"), /*#__PURE__*/React.createElement("li", null, "energielabel a \xB7 gemiddeld 0,08 kwh per gebruik"), /*#__PURE__*/React.createElement("li", null, "productie in fabriek met sa8000-certificering")))), /*#__PURE__*/React.createElement("details", {
    className: "pdp-row"
  }, /*#__PURE__*/React.createElement("summary", null, /*#__PURE__*/React.createElement("span", null, "garantie & retour"), /*#__PURE__*/React.createElement("span", {
    className: "pdp-chev"
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: "chevron-down",
    size: 18
  }))), /*#__PURE__*/React.createElement("div", {
    className: "pdp-row-body"
  }, "2 jaar garantie van hema. 60 dagen ruilen of geld terug \u2014 ook als je gewoon spijt hebt. Breng 'm terug in elke hema-winkel of geef 'm mee aan de bezorger.")));
};

/* ---------- 4. reviews ---------- */
const PDPReviews = () => {
  const stats = [{
    stars: 5,
    pct: 78,
    count: 970
  }, {
    stars: 4,
    pct: 14,
    count: 174
  }, {
    stars: 3,
    pct: 5,
    count: 62
  }, {
    stars: 2,
    pct: 2,
    count: 25
  }, {
    stars: 1,
    pct: 1,
    count: 12
  }];
  const reviews = [{
    title: 'echt heel handig op reis',
    body: 'Genomen voor een citytrip naar Rome — zat opgevouwen in m\'n koffer en blies alle plooien uit mijn linnen jurkjes. Doet wat ie moet doen, niets meer en niets minder.',
    author: 'sanne · amsterdam',
    date: '12 mei',
    rating: 5,
    tag: 'reis'
  }, {
    title: 'snel en lekker licht',
    body: 'In 20 seconden klaar, en ik hoef die strijkplank niet meer uit te klappen. De watertank kan iets groter wat mij betreft, maar voor 2 overhemden voldoende.',
    author: 'pieter · utrecht',
    date: '8 mei',
    rating: 4,
    tag: 'dagelijks gebruik'
  }, {
    title: 'precies wat ik zocht',
    body: 'Mooie afwerking, voelt niet goedkoop aan. Werkt prima op zijde — gewoon de borstel erop en op afstand stomen. Echt een aanrader voor de prijs.',
    author: 'fenna · groningen',
    date: '2 mei',
    rating: 5,
    tag: 'kwaliteit'
  }];
  return /*#__PURE__*/React.createElement("section", {
    id: "reviews",
    style: {
      margin: '0 0 56px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '320px 1fr',
      gap: 56,
      alignItems: 'start'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--bg-subtle)',
      borderRadius: 12,
      padding: 24
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      fontWeight: 700,
      letterSpacing: '.06em',
      textTransform: 'uppercase',
      color: 'var(--fg-3)',
      marginBottom: 6
    }
  }, "klantbeoordeling"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 48,
      fontWeight: 700,
      lineHeight: 1
    }
  }, "4,7"), /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--fg-3)'
    }
  }, "/ 5")), /*#__PURE__*/React.createElement("div", {
    style: {
      margin: '8px 0 4px'
    }
  }, /*#__PURE__*/React.createElement(Stars, {
    value: 4.7,
    size: 18
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: 'var(--fg-3)',
      marginBottom: 18
    }
  }, "op basis van 1.243 reviews \xB7 geverifieerde kopers"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 8
    }
  }, stats.map(s => /*#__PURE__*/React.createElement("div", {
    key: s.stars,
    style: {
      display: 'grid',
      gridTemplateColumns: '28px 1fr 44px',
      alignItems: 'center',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: 'var(--fg-2)',
      fontVariantNumeric: 'tabular-nums'
    }
  }, s.stars, "\u2605"), /*#__PURE__*/React.createElement("span", {
    style: {
      height: 6,
      background: 'var(--stone-100)',
      borderRadius: 999,
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      width: `${s.pct}%`,
      height: '100%',
      background: 'var(--hema-red)'
    }
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: 'var(--fg-3)',
      textAlign: 'right',
      fontVariantNumeric: 'tabular-nums'
    }
  }, s.count)))), /*#__PURE__*/React.createElement("button", {
    className: "btn btn--outline",
    style: {
      width: '100%',
      marginTop: 20
    }
  }, "schrijf een review")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: 24,
      fontWeight: 700,
      textTransform: 'lowercase',
      margin: 0
    }
  }, "wat anderen zeggen"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6,
      fontSize: 13
    }
  }, /*#__PURE__*/React.createElement("button", {
    style: {
      all: 'unset',
      cursor: 'pointer',
      padding: '6px 12px',
      borderRadius: 999,
      background: 'var(--fg-1)',
      color: '#fff',
      fontWeight: 600
    }
  }, "meest behulpzaam"), /*#__PURE__*/React.createElement("button", {
    style: {
      all: 'unset',
      cursor: 'pointer',
      padding: '6px 12px',
      borderRadius: 999,
      border: '1px solid var(--border-1)',
      color: 'var(--fg-1)'
    }
  }, "nieuwste"), /*#__PURE__*/React.createElement("button", {
    style: {
      all: 'unset',
      cursor: 'pointer',
      padding: '6px 12px',
      borderRadius: 999,
      border: '1px solid var(--border-1)',
      color: 'var(--fg-1)'
    }
  }, "met foto"))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6,
      flexWrap: 'wrap',
      marginBottom: 22
    }
  }, ['handig op reis (214)', 'snel klaar (188)', 'lichtgewicht (132)', 'eenvoudig (98)', 'mooie afwerking (76)'].map(t => /*#__PURE__*/React.createElement("span", {
    key: t,
    className: "badge badge--soft",
    style: {
      fontSize: 12
    }
  }, t))), /*#__PURE__*/React.createElement("ul", {
    style: {
      listStyle: 'none',
      padding: 0,
      margin: 0,
      display: 'flex',
      flexDirection: 'column',
      gap: 20
    }
  }, reviews.map((r, i) => /*#__PURE__*/React.createElement("li", {
    key: i,
    style: {
      borderBottom: '1px solid var(--border-1)',
      paddingBottom: 20
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      marginBottom: 4
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement(Stars, {
    value: r.rating,
    size: 14
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 700,
      fontSize: 15
    }
  }, r.title)), /*#__PURE__*/React.createElement("span", {
    className: "badge badge--success",
    style: {
      fontSize: 11
    }
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: "check",
    size: 12
  }), "\xA0 geverifieerde koper")), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 15,
      color: 'var(--fg-2)',
      lineHeight: 1.55,
      margin: '6px 0 10px'
    }
  }, r.body), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: 'var(--fg-3)',
      display: 'flex',
      gap: 10,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("span", null, r.author), " \xB7 ", /*#__PURE__*/React.createElement("span", null, r.date), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 'auto',
      display: 'flex',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("a", {
    href: "#",
    className: "pdp-link",
    style: {
      fontSize: 12
    }
  }, "nuttig (24)"), /*#__PURE__*/React.createElement("a", {
    href: "#",
    className: "pdp-link",
    style: {
      fontSize: 12
    }
  }, "reageer")))))), /*#__PURE__*/React.createElement("button", {
    className: "btn btn--ghost",
    style: {
      marginTop: 14
    }
  }, "laad meer reviews (", (1243 - reviews.length).toLocaleString('nl-NL'), ") ", /*#__PURE__*/React.createElement(HemaIcon, {
    name: "chevron-down",
    size: 14
  })))));
};

/* ---------- 5. FAQ ---------- */
const PDPFaq = () => {
  const FAQ = [{
    q: 'werkt dit ook op kleding die nog op de hanger hangt?',
    a: 'Ja, dat is juist waar deze stomer voor gemaakt is — verticaal stomen, je houdt het kledingstuk gewoon strak en blaast er rustig overheen.'
  }, {
    q: 'kan ik kraanwater gebruiken?',
    a: 'Ja. Bij heel hard water raden we aan om de watertank elke maand een keer te ontkalken met wat natuurazijn.'
  }, {
    q: 'hoe lang stoomt één volle tank?',
    a: 'Ongeveer 12 minuten onafgebroken stomen — genoeg voor een hele rij overhemden of een complete reisset.'
  }, {
    q: 'past dit in de handbagage?',
    a: 'Ja, met afmetingen 25 × 13 × 10 cm en een gewicht van 0,8 kg past hij in alle gangbare handbagagekoffers.'
  }, {
    q: 'is er een aparte opzet voor zijde of wol?',
    a: 'In de doos zit een zachte borstelopzet — die gebruik je voor delicate stoffen zoals zijde, wol en linnen.'
  }];
  return /*#__PURE__*/React.createElement("section", {
    id: "faq",
    style: {
      margin: '0 0 56px'
    }
  }, /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: 28,
      fontWeight: 700,
      textTransform: 'lowercase',
      letterSpacing: '-0.01em',
      margin: '0 0 4px'
    }
  }, "veelgestelde vragen"), /*#__PURE__*/React.createElement("p", {
    style: {
      color: 'var(--fg-3)',
      margin: '0 0 18px',
      fontSize: 14
    }
  }, "beantwoord door de hema-klantenservice & andere kopers"), /*#__PURE__*/React.createElement("div", null, FAQ.map((f, i) => /*#__PURE__*/React.createElement("details", {
    key: i,
    className: "pdp-row",
    open: i === 0
  }, /*#__PURE__*/React.createElement("summary", null, /*#__PURE__*/React.createElement("span", null, f.q), /*#__PURE__*/React.createElement("span", {
    className: "pdp-chev"
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: "chevron-down",
    size: 18
  }))), /*#__PURE__*/React.createElement("div", {
    className: "pdp-row-body"
  }, f.a)))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 22,
      padding: '18px 22px',
      background: 'var(--bg-subtle)',
      borderRadius: 12,
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 16,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 700,
      fontSize: 16
    }
  }, "nog een vraag?"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      color: 'var(--fg-2)'
    }
  }, "we zijn ma\u2013za bereikbaar van 8 tot 22 uur. ook in de winkel helpen we je graag verder.")), /*#__PURE__*/React.createElement("button", {
    className: "btn btn--dark"
  }, "stel je vraag")));
};

/* ---------- 6. samen gekocht ---------- */
const PDPBundle = () => {
  const items = [{
    name: 'kledingstomer 1500w',
    price: 25,
    sub: 'mintgroen',
    tag: 'dit artikel'
  }, {
    name: 'reishoes voor stomer',
    price: 6,
    sub: 'past om model 1500w'
  }, {
    name: 'ontkalker 250 ml',
    price: 4,
    sub: 'voor 12 ontkalkingen'
  }];
  const total = items.reduce((s, i) => s + i.price, 0);
  return /*#__PURE__*/React.createElement("section", {
    style: {
      margin: '8px 0 56px'
    }
  }, /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: 28,
      fontWeight: 700,
      textTransform: 'lowercase',
      letterSpacing: '-0.01em',
      margin: '0 0 4px'
    }
  }, "vaak samen gekocht"), /*#__PURE__*/React.createElement("p", {
    style: {
      color: 'var(--fg-3)',
      margin: '0 0 18px',
      fontSize: 14
    }
  }, "koop alle drie en je houdt je stomer langer als nieuw."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'auto auto auto auto 1fr auto',
      gap: 16,
      alignItems: 'center',
      background: 'var(--bg-subtle)',
      borderRadius: 12,
      padding: 22
    }
  }, items.map((it, i) => /*#__PURE__*/React.createElement(React.Fragment, {
    key: it.name
  }, /*#__PURE__*/React.createElement("label", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 8,
      cursor: 'pointer'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 140,
      height: 140,
      borderRadius: 10,
      background: '#fff',
      border: '1px solid var(--border-1)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    defaultChecked: true,
    style: {
      position: 'absolute',
      top: 8,
      left: 8,
      width: 18,
      height: 18,
      accentColor: 'var(--hema-red)'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 11,
      color: 'var(--fg-3)',
      background: 'var(--bg-subtle)',
      padding: '4px 8px',
      borderRadius: 4
    }
  }, "productfoto")), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: 'center',
      maxWidth: 140
    }
  }, it.tag && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: 'var(--hema-red)',
      fontWeight: 700,
      textTransform: 'uppercase',
      letterSpacing: '.04em'
    }
  }, it.tag), /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 600,
      fontSize: 14,
      lineHeight: 1.25,
      marginTop: 2
    }
  }, it.name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: 'var(--fg-3)'
    }
  }, it.sub), /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 700,
      marginTop: 4,
      fontVariantNumeric: 'tabular-nums'
    }
  }, "\u20AC\xA0", it.price))), i < items.length - 1 && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 26,
      color: 'var(--fg-3)'
    }
  }, "+"))), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: 'right',
      borderLeft: '1px solid var(--border-1)',
      paddingLeft: 24,
      marginLeft: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: 'var(--fg-3)'
    }
  }, "totaal voor 3"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 30,
      fontWeight: 700,
      color: 'var(--hema-red)',
      fontVariantNumeric: 'tabular-nums'
    }
  }, "\u20AC\xA0", total), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: 'var(--fg-3)',
      margin: '0 0 10px'
    }
  }, "jij bespaart \u20AC 2"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn--primary btn--sm"
  }, "voeg alle 3 toe"))));
};

/* ---------- 7. compare table ---------- */
const PDPCompare = () => {
  const cols = [{
    name: 'kledingstomer 1500w',
    price: 25,
    sub: 'dit artikel',
    power: '1500 w',
    tank: '300 ml',
    warm: '20 sec',
    wt: '0,8 kg',
    this: true
  }, {
    name: 'kledingstomer 1200w',
    price: 18,
    sub: 'compact',
    power: '1200 w',
    tank: '200 ml',
    warm: '30 sec',
    wt: '0,6 kg'
  }, {
    name: 'stoomstrijkijzer xl',
    price: 35,
    sub: 'voor strijkplank',
    power: '2400 w',
    tank: '350 ml',
    warm: '40 sec',
    wt: '1,4 kg'
  }, {
    name: 'reisstomer mini',
    price: 12,
    sub: 'opvouwbaar',
    power: '900 w',
    tank: '120 ml',
    warm: '25 sec',
    wt: '0,5 kg'
  }];
  return /*#__PURE__*/React.createElement("section", {
    style: {
      margin: '8px 0 56px'
    }
  }, /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: 28,
      fontWeight: 700,
      textTransform: 'lowercase',
      letterSpacing: '-0.01em',
      margin: '0 0 18px'
    }
  }, "twijfel je nog tussen modellen?"), /*#__PURE__*/React.createElement("div", {
    style: {
      overflowX: 'auto'
    }
  }, /*#__PURE__*/React.createElement("table", {
    style: {
      width: '100%',
      borderCollapse: 'collapse',
      fontSize: 14,
      minWidth: 720
    }
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: 'left',
      padding: '10px 12px',
      color: 'var(--fg-3)',
      fontWeight: 500
    }
  }), cols.map(c => /*#__PURE__*/React.createElement("th", {
    key: c.name,
    style: {
      textAlign: 'left',
      padding: '14px',
      background: c.this ? 'var(--bg-subtle)' : 'transparent',
      borderTopLeftRadius: 10,
      borderTopRightRadius: 10,
      verticalAlign: 'top'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      aspectRatio: '1/1',
      width: '100%',
      borderRadius: 8,
      background: '#fff',
      border: '1px solid var(--border-1)',
      marginBottom: 10,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 10,
      color: 'var(--fg-3)'
    }
  }, "productfoto")), c.this && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: 'var(--hema-red)',
      fontWeight: 700,
      textTransform: 'uppercase',
      letterSpacing: '.04em',
      marginBottom: 2
    }
  }, "dit artikel"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 700,
      lineHeight: 1.2
    }
  }, c.name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: 'var(--fg-3)'
    }
  }, c.sub), /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 700,
      marginTop: 6,
      fontSize: 18,
      fontVariantNumeric: 'tabular-nums'
    }
  }, "\u20AC\xA0", c.price))))), /*#__PURE__*/React.createElement("tbody", null, [['vermogen', 'power'], ['watertank', 'tank'], ['opwarmtijd', 'warm'], ['gewicht', 'wt']].map(([label, key], i) => /*#__PURE__*/React.createElement("tr", {
    key: key
  }, /*#__PURE__*/React.createElement("td", {
    style: {
      padding: '12px',
      color: 'var(--fg-3)',
      borderTop: '1px solid var(--border-1)'
    }
  }, label), cols.map(c => /*#__PURE__*/React.createElement("td", {
    key: c.name,
    style: {
      padding: '12px',
      background: c.this ? 'var(--bg-subtle)' : 'transparent',
      fontWeight: 600,
      borderTop: '1px solid var(--border-1)'
    }
  }, c[key])))), /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", null), cols.map(c => /*#__PURE__*/React.createElement("td", {
    key: c.name,
    style: {
      padding: 14,
      background: c.this ? 'var(--bg-subtle)' : 'transparent',
      borderBottomLeftRadius: 10,
      borderBottomRightRadius: 10
    }
  }, c.this ? /*#__PURE__*/React.createElement("button", {
    className: "btn btn--primary btn--sm",
    style: {
      width: '100%'
    },
    disabled: true
  }, "geselecteerd") : /*#__PURE__*/React.createElement("button", {
    className: "btn btn--outline btn--sm",
    style: {
      width: '100%'
    }
  }, "bekijk"))))))));
};

/* ---------- 8. related strip ---------- */
const PDPRelated = ({
  title,
  onNav,
  slice = [0, 5]
}) => {
  const items = WEB_PRODUCTS_ALL.slice(slice[0], slice[1]);
  return /*#__PURE__*/React.createElement("section", {
    style: {
      margin: '8px 0 56px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      marginBottom: 18
    }
  }, /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: 28,
      fontWeight: 700,
      textTransform: 'lowercase',
      letterSpacing: '-0.01em',
      margin: 0
    }
  }, title), /*#__PURE__*/React.createElement("a", {
    href: "#",
    className: "pdp-link",
    style: {
      fontSize: 14
    }
  }, "alles bekijken \u2192")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(5, 1fr)',
      gap: 14
    }
  }, items.map(p => /*#__PURE__*/React.createElement(HemaProductCard, {
    key: p.id,
    p: p,
    onClick: () => onNav && onNav('product', p.id)
  }))));
};
window.PDPSections = {
  PDPHighlights,
  PDPDescription,
  PDPSpecs,
  PDPReviews,
  PDPFaq,
  PDPBundle,
  PDPCompare,
  PDPRelated
};
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web/PDPSections.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web/ProductCard.jsx
try { (() => {
// ProductCard.jsx — image (coloured square placeholder), name, price.

const placeholderSvg = (color, label) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <rect width="200" height="200" fill="#f5f3ee"/>
  <rect x="40" y="40" width="120" height="120" rx="10" fill="${color}"/>
  <text x="100" y="190" text-anchor="middle" font-family="Mulish, sans-serif" font-size="12" fill="#7b766e">${label}</text>
</svg>`.trim();
const ProductCard = ({
  p,
  onClick
}) => {
  const imgSrc = `data:image/svg+xml;utf8,${encodeURIComponent(placeholderSvg(p.color, p.name))}`;
  const onSale = !!p.was;
  return /*#__PURE__*/React.createElement("article", {
    onClick: () => onClick && onClick(p),
    className: "card",
    style: {
      background: '#fff',
      borderRadius: 8,
      overflow: 'hidden',
      cursor: 'pointer',
      display: 'flex',
      flexDirection: 'column'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      aspectRatio: '1/1',
      background: 'var(--stone-50)'
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: imgSrc,
    alt: p.name,
    style: {
      width: '100%',
      height: '100%',
      display: 'block'
    }
  }), p.badge && /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      top: 10,
      left: 10,
      background: p.badge.startsWith('-') ? 'var(--label-yellow)' : 'var(--hema-red)',
      color: p.badge.startsWith('-') ? '#14100c' : '#fff',
      fontSize: 12,
      fontWeight: 700,
      padding: '3px 10px',
      borderRadius: 999,
      textTransform: 'lowercase'
    }
  }, p.badge), /*#__PURE__*/React.createElement("button", {
    onClick: e => e.stopPropagation(),
    style: {
      position: 'absolute',
      top: 10,
      right: 10,
      width: 34,
      height: 34,
      background: '#fff',
      border: 'none',
      borderRadius: 999,
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: 'var(--fg-1)',
      boxShadow: 'var(--shadow-sticky)'
    }
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: "heart",
    size: 18
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '12px 14px 16px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      color: 'var(--fg-1)',
      marginBottom: 6,
      lineHeight: 1.35
    }
  }, p.name), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 19,
      fontWeight: 700,
      color: onSale ? 'var(--hema-red)' : 'var(--fg-1)',
      fontVariantNumeric: 'tabular-nums'
    }
  }, "\u20AC\xA0", p.price), onSale && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      color: 'var(--fg-3)',
      textDecoration: 'line-through'
    }
  }, "\u20AC\xA0", p.was))));
};
window.HemaProductCard = ProductCard;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web/ProductCard.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web/Screens.jsx
try { (() => {
// Screens.jsx — Home, Category, ProductDetail, Cart.

const {
  PRODUCTS: WEB_PRODUCTS,
  CATEGORIES: WEB_CATEGORIES
} = window.HEMA_DATA;

// ---- HOME ------------------------------------------------------------------
const HomeScreen = ({
  onNav,
  onAdd
}) => {
  const HS = window.HemaHomeSections || {};
  return /*#__PURE__*/React.createElement("main", null, /*#__PURE__*/React.createElement(HemaHero, {
    onNav: onNav
  }), HS.LiveActivity && /*#__PURE__*/React.createElement(HS.LiveActivity, null), HS.QuickCategories && /*#__PURE__*/React.createElement(HS.QuickCategories, {
    onNav: onNav
  }), HS.FlashDeals && /*#__PURE__*/React.createElement(HS.FlashDeals, {
    onNav: onNav,
    onAdd: onAdd
  }), /*#__PURE__*/React.createElement("section", {
    style: {
      marginBottom: 56
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      marginBottom: 18
    }
  }, /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: 28,
      fontWeight: 700,
      textTransform: 'lowercase',
      letterSpacing: '-0.01em',
      margin: 0
    }
  }, "shop op categorie")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(4, 1fr)',
      gap: 14
    }
  }, WEB_CATEGORIES.map(c => /*#__PURE__*/React.createElement(HemaCategoryTile, {
    key: c.id,
    cat: c,
    onClick: () => onNav('category', c.label)
  })))), HS.BestsellersTop10 && /*#__PURE__*/React.createElement(HS.BestsellersTop10, {
    onNav: onNav
  }), HS.CakeConfigurator && /*#__PURE__*/React.createElement(HS.CakeConfigurator, null), /*#__PURE__*/React.createElement(HemaServiceRow, null), /*#__PURE__*/React.createElement("section", {
    style: {
      marginBottom: 56
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      marginBottom: 18
    }
  }, /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: 28,
      fontWeight: 700,
      textTransform: 'lowercase',
      letterSpacing: '-0.01em',
      margin: 0
    }
  }, "nieuw deze week"), /*#__PURE__*/React.createElement("a", {
    href: "#",
    onClick: e => {
      e.preventDefault();
      onNav('category', 'nieuw');
    },
    style: {
      fontSize: 14,
      fontWeight: 600
    }
  }, "alles bekijken \u2192")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(5, 1fr)',
      gap: 14
    }
  }, WEB_PRODUCTS.slice(0, 5).map(p => /*#__PURE__*/React.createElement(HemaProductCard, {
    key: p.id,
    p: p,
    onClick: () => onNav('product', p.id)
  })))), HS.RecipeOfTheWeek && /*#__PURE__*/React.createElement(HS.RecipeOfTheWeek, null), HS.MeerHemaProgress && /*#__PURE__*/React.createElement(HS.MeerHemaProgress, null), /*#__PURE__*/React.createElement("section", {
    style: {
      background: '#ed2923',
      color: '#fff',
      borderRadius: 16,
      padding: '48px 56px',
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      alignItems: 'center',
      gap: 40,
      marginBottom: 24
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      fontWeight: 700,
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
      marginBottom: 14,
      opacity: .85
    }
  }, "nieuwsbrief"), /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: 38,
      fontWeight: 700,
      lineHeight: 1,
      letterSpacing: '-0.02em',
      textTransform: 'lowercase',
      margin: '0 0 14px'
    }
  }, "blijf op de hoogte"), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      fontSize: 17,
      opacity: .9,
      lineHeight: 1.45
    }
  }, "elke week de nieuwste aanbiedingen, recepten en producten in je inbox.")), /*#__PURE__*/React.createElement("form", {
    onSubmit: e => e.preventDefault(),
    style: {
      display: 'flex',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("input", {
    className: "input",
    placeholder: "je e\u2011mailadres",
    style: {
      background: '#fff',
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("button", {
    type: "submit",
    className: "btn btn--dark"
  }, "aanmelden"))));
};

// ---- CATEGORY --------------------------------------------------------------
const CategoryScreen = ({
  slug,
  onNav
}) => {
  const cat = WEB_CATEGORIES.find(c => c.label === slug);
  const items = slug === 'nieuw' || slug === 'aanbiedingen' || !cat ? WEB_PRODUCTS : WEB_PRODUCTS.filter(p => p.cat === cat.id);
  const [filter, setFilter] = React.useState('alles');
  return /*#__PURE__*/React.createElement("main", null, /*#__PURE__*/React.createElement("nav", {
    style: {
      fontSize: 13,
      color: 'var(--fg-3)',
      margin: '24px 0 12px'
    }
  }, /*#__PURE__*/React.createElement("a", {
    href: "#",
    onClick: e => {
      e.preventDefault();
      onNav('home');
    },
    style: {
      color: 'var(--fg-3)'
    }
  }, "home"), /*#__PURE__*/React.createElement("span", {
    style: {
      margin: '0 8px'
    }
  }, "\xB7"), /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--fg-1)'
    }
  }, slug || 'alles')), /*#__PURE__*/React.createElement("h1", {
    style: {
      fontSize: 44,
      fontWeight: 700,
      letterSpacing: '-0.02em',
      textTransform: 'lowercase',
      margin: '0 0 8px'
    }
  }, slug || 'alles'), /*#__PURE__*/React.createElement("p", {
    style: {
      color: 'var(--fg-3)',
      fontSize: 15,
      margin: '0 0 28px'
    }
  }, items.length, " producten"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      flexWrap: 'wrap',
      marginBottom: 26
    }
  }, ['alles', 'nieuw', 'aanbiedingen', '€ 0 – 5', '€ 5 – 10', 'op voorraad'].map(f => /*#__PURE__*/React.createElement("button", {
    key: f,
    onClick: () => setFilter(f),
    style: {
      padding: '8px 16px',
      borderRadius: 999,
      fontSize: 13,
      fontWeight: 600,
      fontFamily: 'inherit',
      cursor: 'pointer',
      textTransform: 'lowercase',
      background: filter === f ? '#14100c' : '#fff',
      color: filter === f ? '#fff' : 'var(--fg-1)',
      border: filter === f ? '1px solid #14100c' : '1px solid var(--border-1)'
    }
  }, f)), /*#__PURE__*/React.createElement("button", {
    style: {
      padding: '8px 14px',
      borderRadius: 999,
      fontSize: 13,
      fontWeight: 600,
      fontFamily: 'inherit',
      cursor: 'pointer',
      textTransform: 'lowercase',
      background: '#fff',
      color: 'var(--fg-1)',
      border: '1px solid var(--border-1)',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      marginLeft: 'auto'
    }
  }, "sorteer op: aanbevolen ", /*#__PURE__*/React.createElement(HemaIcon, {
    name: "chevron-down",
    size: 14
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(4, 1fr)',
      gap: 14
    }
  }, items.map(p => /*#__PURE__*/React.createElement(HemaProductCard, {
    key: p.id,
    p: p,
    onClick: () => onNav('product', p.id)
  }))));
};

// ---- PRODUCT DETAIL --------------------------------------------------------
const ProductScreen = ({
  id,
  onAdd,
  onNav
}) => {
  const p = WEB_PRODUCTS.find(x => x.id === id) || WEB_PRODUCTS[0];
  const [size, setSize] = React.useState('m');
  const [qty, setQty] = React.useState(1);
  const placeholder = (color, label) => `data:image/svg+xml;utf8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <rect width="200" height="200" fill="#f5f3ee"/>
  <rect x="40" y="40" width="120" height="120" rx="10" fill="${color}"/>
</svg>`)}`;
  return /*#__PURE__*/React.createElement("main", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1.1fr 1fr',
      gap: 48,
      margin: '32px 0'
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      aspectRatio: '1/1',
      background: 'var(--bg-subtle)',
      borderRadius: 16,
      overflow: 'hidden',
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: placeholder(p.color),
    alt: p.name,
    style: {
      width: '100%',
      height: '100%'
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(4, 1fr)',
      gap: 10
    }
  }, [p.color, '#fff', '#1a1a1a', p.color].map((c, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      aspectRatio: '1/1',
      background: 'var(--bg-subtle)',
      borderRadius: 8,
      padding: 12,
      border: i === 0 ? '2px solid var(--hema-red)' : '2px solid transparent',
      cursor: 'pointer'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: c,
      height: '100%',
      borderRadius: 6,
      border: c === '#fff' ? '1px solid var(--border-1)' : 'none'
    }
  }))))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("nav", {
    style: {
      fontSize: 13,
      color: 'var(--fg-3)',
      marginBottom: 18
    }
  }, /*#__PURE__*/React.createElement("a", {
    href: "#",
    onClick: e => {
      e.preventDefault();
      onNav('home');
    },
    style: {
      color: 'var(--fg-3)'
    }
  }, "home"), /*#__PURE__*/React.createElement("span", {
    style: {
      margin: '0 8px'
    }
  }, "\xB7"), /*#__PURE__*/React.createElement("a", {
    href: "#",
    onClick: e => {
      e.preventDefault();
      onNav('category', p.cat);
    },
    style: {
      color: 'var(--fg-3)'
    }
  }, p.cat)), /*#__PURE__*/React.createElement("h1", {
    style: {
      fontSize: 36,
      fontWeight: 700,
      lineHeight: 1.05,
      letterSpacing: '-0.02em',
      textTransform: 'lowercase',
      margin: '0 0 12px'
    }
  }, p.name), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginBottom: 6
    }
  }, [1, 2, 3, 4, 5].map(s => /*#__PURE__*/React.createElement(HemaIcon, {
    key: s,
    name: "star",
    size: 16,
    color: s <= 4 ? '#f5c518' : '#c9c4ba'
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      color: 'var(--fg-3)',
      marginLeft: 4
    }
  }, "4,3 \xB7 128 reviews")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 10,
      margin: '20px 0 4px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 36,
      fontWeight: 700,
      fontVariantNumeric: 'tabular-nums',
      color: p.was ? 'var(--hema-red)' : 'var(--fg-1)'
    }
  }, "\u20AC\xA0", p.price), p.was && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 18,
      color: 'var(--fg-3)',
      textDecoration: 'line-through'
    }
  }, "\u20AC\xA0", p.was)), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: 'var(--fg-3)',
      marginBottom: 22
    }
  }, "incl. btw \xB7 vandaag besteld, morgen in huis"), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 22
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      fontWeight: 700,
      marginBottom: 10
    }
  }, "maat"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8
    }
  }, ['xs', 's', 'm', 'l', 'xl'].map(s => /*#__PURE__*/React.createElement("button", {
    key: s,
    onClick: () => setSize(s),
    style: {
      width: 50,
      height: 44,
      borderRadius: 8,
      border: size === s ? '2px solid var(--fg-1)' : '1px solid var(--border-1)',
      background: '#fff',
      cursor: 'pointer',
      fontSize: 14,
      fontWeight: 700,
      fontFamily: 'inherit',
      textTransform: 'uppercase'
    }
  }, s)))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 12,
      marginBottom: 28
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      border: '1px solid var(--border-1)',
      borderRadius: 999
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setQty(Math.max(1, qty - 1)),
    style: {
      width: 44,
      height: 44,
      border: 'none',
      background: 'transparent',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: "minus",
    size: 16
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      minWidth: 28,
      textAlign: 'center',
      fontWeight: 700
    }
  }, qty), /*#__PURE__*/React.createElement("button", {
    onClick: () => setQty(qty + 1),
    style: {
      width: 44,
      height: 44,
      border: 'none',
      background: 'transparent',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: "plus",
    size: 16
  }))), /*#__PURE__*/React.createElement("button", {
    className: "btn btn--primary btn--lg",
    style: {
      flex: 1
    },
    onClick: () => onAdd(p, qty)
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: "cart",
    size: 18
  }), " in winkelmandje")), /*#__PURE__*/React.createElement("ul", {
    style: {
      listStyle: 'none',
      padding: 0,
      margin: 0,
      display: 'flex',
      flexDirection: 'column',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("li", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      fontSize: 14,
      color: 'var(--fg-2)'
    }
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: "truck",
    size: 18,
    color: "var(--hema-red)"
  }), " morgen bij je in huis \xB7 bestel voor 22:00"), /*#__PURE__*/React.createElement("li", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      fontSize: 14,
      color: 'var(--fg-2)'
    }
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: "return",
    size: 18,
    color: "var(--hema-red)"
  }), " 60 dagen retour, gratis in de winkel"), /*#__PURE__*/React.createElement("li", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      fontSize: 14,
      color: 'var(--fg-2)'
    }
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: "pin",
    size: 18,
    color: "var(--hema-red)"
  }), " nu beschikbaar in 12 winkels in de buurt"))));
};

// ---- CART ------------------------------------------------------------------
const CartScreen = ({
  cart,
  setCart,
  onNav
}) => {
  const items = cart.map(c => ({
    ...WEB_PRODUCTS.find(p => p.id === c.id),
    qty: c.qty
  }));
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  const shipping = subtotal >= 30 || subtotal === 0 ? 0 : 4;
  const total = subtotal + shipping;
  const updateQty = (id, delta) => {
    setCart(c => c.map(i => i.id === id ? {
      ...i,
      qty: Math.max(0, i.qty + delta)
    } : i).filter(i => i.qty > 0));
  };
  const placeholder = color => `data:image/svg+xml;utf8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="#f5f3ee"/>
  <rect x="20" y="20" width="60" height="60" rx="6" fill="${color}"/>
</svg>`)}`;
  return /*#__PURE__*/React.createElement("main", {
    style: {
      margin: '32px 0',
      display: 'grid',
      gridTemplateColumns: '1.6fr 1fr',
      gap: 40
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h1", {
    style: {
      fontSize: 40,
      fontWeight: 700,
      letterSpacing: '-0.02em',
      textTransform: 'lowercase',
      margin: '0 0 8px'
    }
  }, "mijn winkelmandje"), /*#__PURE__*/React.createElement("p", {
    style: {
      color: 'var(--fg-3)',
      margin: '0 0 24px'
    }
  }, items.length, " artikel(en)"), items.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--bg-subtle)',
      borderRadius: 12,
      padding: 48,
      textAlign: 'center'
    }
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: "cart",
    size: 42,
    color: "var(--fg-3)"
  }), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 17,
      fontWeight: 600,
      margin: '12px 0 4px'
    }
  }, "je mandje is leeg"), /*#__PURE__*/React.createElement("p", {
    style: {
      color: 'var(--fg-3)',
      margin: '0 0 18px'
    }
  }, "kijk gerust rond, we hebben genoeg te bieden"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn--primary",
    onClick: () => onNav('home')
  }, "verder winkelen")) : /*#__PURE__*/React.createElement("ul", {
    style: {
      listStyle: 'none',
      padding: 0,
      margin: 0,
      display: 'flex',
      flexDirection: 'column',
      gap: 12
    }
  }, items.map(i => /*#__PURE__*/React.createElement("li", {
    key: i.id,
    style: {
      display: 'grid',
      gridTemplateColumns: '80px 1fr auto auto',
      gap: 18,
      alignItems: 'center',
      padding: '12px',
      background: '#fff',
      borderRadius: 8,
      border: '1px solid var(--border-1)'
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: placeholder(i.color),
    alt: i.name,
    style: {
      width: 80,
      height: 80,
      borderRadius: 6
    }
  }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 600
    }
  }, i.name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: 'var(--fg-3)'
    }
  }, i.cat)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      border: '1px solid var(--border-1)',
      borderRadius: 999,
      height: 36
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => updateQty(i.id, -1),
    style: {
      width: 36,
      height: 36,
      border: 'none',
      background: 'transparent',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: "minus",
    size: 14
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      minWidth: 22,
      textAlign: 'center',
      fontWeight: 700
    }
  }, i.qty), /*#__PURE__*/React.createElement("button", {
    onClick: () => updateQty(i.id, +1),
    style: {
      width: 36,
      height: 36,
      border: 'none',
      background: 'transparent',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: "plus",
    size: 14
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 700,
      fontSize: 16,
      minWidth: 60,
      textAlign: 'right',
      fontVariantNumeric: 'tabular-nums'
    }
  }, "\u20AC\xA0", i.price * i.qty))))), /*#__PURE__*/React.createElement("aside", {
    style: {
      background: 'var(--bg-subtle)',
      borderRadius: 12,
      padding: 24,
      height: 'fit-content',
      position: 'sticky',
      top: 200
    }
  }, /*#__PURE__*/React.createElement("h3", {
    style: {
      fontSize: 18,
      fontWeight: 700,
      textTransform: 'lowercase',
      margin: '0 0 16px'
    }
  }, "jouw bestelling"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      fontSize: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between'
    }
  }, /*#__PURE__*/React.createElement("span", null, "subtotaal"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontVariantNumeric: 'tabular-nums'
    }
  }, "\u20AC\xA0", subtotal)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between'
    }
  }, /*#__PURE__*/React.createElement("span", null, "verzending"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontVariantNumeric: 'tabular-nums',
      color: shipping === 0 ? 'var(--success)' : 'var(--fg-1)'
    }
  }, shipping === 0 ? 'gratis' : `€ ${shipping}`)), subtotal > 0 && subtotal < 30 && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: 'var(--fg-3)',
      marginTop: 2
    }
  }, "nog \u20AC ", 30 - subtotal, " voor gratis verzending")), /*#__PURE__*/React.createElement("hr", {
    style: {
      border: 'none',
      borderTop: '1px solid var(--border-1)',
      margin: '16px 0'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      fontSize: 18,
      fontWeight: 700
    }
  }, /*#__PURE__*/React.createElement("span", null, "totaal"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontVariantNumeric: 'tabular-nums'
    }
  }, "\u20AC\xA0", total)), /*#__PURE__*/React.createElement("button", {
    className: "btn btn--primary",
    style: {
      width: '100%',
      marginTop: 18
    },
    disabled: items.length === 0
  }, "afrekenen"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn--ghost",
    style: {
      width: '100%',
      marginTop: 8
    },
    onClick: () => onNav('home')
  }, "verder winkelen")));
};
window.HemaScreens = {
  HomeScreen,
  CategoryScreen,
  ProductScreen,
  CartScreen
};
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web/Screens.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web/Toast.jsx
try { (() => {
// Toast.jsx — bottom-right fade-in toast for "added to bag", etc.

const Toast = ({
  msg,
  sub,
  onDismiss
}) => {
  React.useEffect(() => {
    const t = setTimeout(() => onDismiss && onDismiss(), 3000);
    return () => clearTimeout(t);
  }, []);
  if (!msg) return null;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'fixed',
      bottom: 24,
      right: 24,
      zIndex: 100,
      background: '#fff',
      borderRadius: 8,
      padding: '14px 18px',
      boxShadow: '0 4px 16px rgba(20,16,12,0.08), 0 1px 2px rgba(20,16,12,0.04)',
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      animation: 'hemaToastIn .22s var(--ease-out)',
      maxWidth: 360
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 32,
      height: 32,
      borderRadius: 999,
      background: '#2f8a3e',
      color: '#fff',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: '0 0 auto'
    }
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: "check",
    size: 18
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      fontWeight: 700
    }
  }, msg), sub && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: 'var(--fg-3)'
    }
  }, sub)), /*#__PURE__*/React.createElement("button", {
    onClick: onDismiss,
    style: {
      background: 'transparent',
      border: 'none',
      cursor: 'pointer',
      color: 'var(--fg-3)',
      padding: 4
    }
  }, /*#__PURE__*/React.createElement(HemaIcon, {
    name: "close",
    size: 16
  })), /*#__PURE__*/React.createElement("style", null, `
        @keyframes hemaToastIn {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `));
};
window.HemaToast = Toast;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web/Toast.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web/app.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
// app.jsx — router glue between screens, cart state, toast.

const {
  useState
} = React;
const {
  HomeScreen,
  CategoryScreen,
  ProductScreen,
  CartScreen
} = window.HemaScreens;
function App() {
  const [view, setView] = useState({
    name: 'home',
    arg: null
  });
  const [cart, setCart] = useState([]);
  const [toast, setToast] = useState(null);
  const onNav = (name, arg) => {
    setView({
      name,
      arg
    });
    window.scrollTo({
      top: 0,
      behavior: 'smooth'
    });
  };
  const addToCart = (p, qty = 1) => {
    setCart(c => {
      const found = c.find(i => i.id === p.id);
      return found ? c.map(i => i.id === p.id ? {
        ...i,
        qty: i.qty + qty
      } : i) : [...c, {
        id: p.id,
        qty
      }];
    });
    setToast({
      msg: 'toegevoegd aan je mandje',
      sub: `${qty} × ${p.name}`
    });
  };
  const onSearch = q => {
    if (q) onNav('category', q);
  };
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(HemaHeader, {
    onNav: onNav,
    cartCount: cart.reduce((s, i) => s + i.qty, 0),
    onSearch: onSearch
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 1280,
      margin: '0 auto',
      padding: '0 24px',
      minHeight: '60vh'
    }
  }, view.name === 'home' && /*#__PURE__*/React.createElement(HomeScreen, {
    onNav: onNav,
    onAdd: addToCart
  }), view.name === 'category' && /*#__PURE__*/React.createElement(CategoryScreen, {
    slug: view.arg,
    onNav: onNav
  }), view.name === 'product' && /*#__PURE__*/React.createElement(ProductScreen, {
    id: view.arg,
    onAdd: addToCart,
    onNav: onNav
  }), view.name === 'cart' && /*#__PURE__*/React.createElement(CartScreen, {
    cart: cart,
    setCart: setCart,
    onNav: onNav
  })), /*#__PURE__*/React.createElement(HemaFooter, null), toast && /*#__PURE__*/React.createElement(HemaToast, _extends({}, toast, {
    onDismiss: () => setToast(null)
  })));
}
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(/*#__PURE__*/React.createElement(App, null));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web/app.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web/data.js
try { (() => {
// Fake catalogue powering the web UI kit. All lowercase, round Euro prices.
const PRODUCTS = [{
  id: 'n1',
  name: 'notitieboekje a5',
  price: 3,
  cat: 'kantoor',
  color: '#f5c518',
  badge: 'nieuw'
}, {
  id: 'n2',
  name: 'drinkbeker stip teal',
  price: 4,
  cat: 'koken',
  color: '#2aa8a8'
}, {
  id: 'n3',
  name: 'badmat zacht roze',
  price: 6,
  was: 9,
  cat: 'badkamer',
  color: '#ec6ca0',
  badge: '-33%'
}, {
  id: 'n4',
  name: 'plaid effen lichtblauw',
  price: 12,
  cat: 'wonen',
  color: '#4ab4e6'
}, {
  id: 'n5',
  name: 'kaarsenset 3 stuks',
  price: 5,
  cat: 'wonen',
  color: '#f08d2c'
}, {
  id: 'n6',
  name: 'theelichtjes 50 stuks',
  price: 4,
  cat: 'wonen',
  color: '#1a1a1a'
}, {
  id: 'n7',
  name: 'kookboek alledag',
  price: 10,
  cat: 'koken',
  color: '#6cb33e',
  badge: 'nieuw'
}, {
  id: 'n8',
  name: 'handdoek wafel groen',
  price: 7,
  cat: 'badkamer',
  color: '#6cb33e'
}, {
  id: 'n9',
  name: 'beker met deksel',
  price: 5,
  was: 8,
  cat: 'koken',
  color: '#7b51a1',
  badge: '-38%'
}, {
  id: 'n10',
  name: 'kussensloop bloesem',
  price: 8,
  cat: 'wonen',
  color: '#ec6ca0'
}, {
  id: 'n11',
  name: 'sokken 3-pack',
  price: 6,
  cat: 'kleding',
  color: '#1f6fb4'
}, {
  id: 'n12',
  name: 'shampoo + conditioner',
  price: 4,
  cat: 'verzorging',
  color: '#f5c518'
}, {
  id: 'n13',
  name: 'puzzel 1000 stukjes',
  price: 12,
  cat: 'speelgoed',
  color: '#f08d2c'
}, {
  id: 'n14',
  name: 'verjaardagskaart vriend',
  price: 2,
  cat: 'kantoor',
  color: '#ec6ca0'
}, {
  id: 'n15',
  name: 'leesbril +1.5',
  price: 5,
  cat: 'verzorging',
  color: '#7b51a1'
}];
const CATEGORIES = [{
  id: 'wonen',
  label: 'wonen',
  color: '#f5c518'
}, {
  id: 'koken',
  label: 'koken',
  color: '#2aa8a8'
}, {
  id: 'badkamer',
  label: 'badkamer',
  color: '#ec6ca0'
}, {
  id: 'kleding',
  label: 'kleding',
  color: '#1f6fb4'
}, {
  id: 'kantoor',
  label: 'kantoor & papier',
  color: '#f08d2c'
}, {
  id: 'verzorging',
  label: 'verzorging',
  color: '#6cb33e'
}, {
  id: 'speelgoed',
  label: 'speelgoed',
  color: '#7b51a1'
}, {
  id: 'eten',
  label: 'eten & drinken',
  color: '#ed2923'
}];
window.HEMA_DATA = {
  PRODUCTS,
  CATEGORIES
};
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web/data.js", error: String((e && e.message) || e) }); }

})();
