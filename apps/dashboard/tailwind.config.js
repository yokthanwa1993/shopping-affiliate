/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      boxShadow: {
        panel: '0 24px 80px rgba(15, 23, 42, 0.08)',
      },
      colors: {
        brand: {
          blue: '#1877f2',
          navy: '#0f2f6f',
          ink: '#0f172a',
          mist: '#eef5ff',
        },
      },
    },
  },
  plugins: [],
}
