// Keep match setup usable before the game downloads Three.js or any venue assets.
export const FIELDS = {
  courtyard: {
    name: 'Monastery courtyard',
    load: () => import('./courtyard.js').then(module => module.addCourtyard),
  },
  meteora: {
    name: 'Meteora cliff-top',
    load: () => import('./venues-extra.js').then(module => module.addMeteora),
  },
  winter: {
    name: 'Winter monastery',
    load: () => import('./venues-extra.js').then(module => module.addWinterMonastery),
  },
};

export function matchSetup(params) {
  const field = params.get('field')?.trim().toLowerCase();
  return {
    size: params.get('size') === '3' ? 3 : 5,
    field: Object.hasOwn(FIELDS, field) ? field : 'courtyard',
  };
}
