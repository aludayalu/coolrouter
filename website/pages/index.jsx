import dynamic from "next/dynamic";

const ColorBends = dynamic(() => import("../components/colorBends"), {
  ssr: false
});

export default function App() {
  return (
    <>
    <div style={{ width: '100%', height: '100vh', position: 'absolute' }}>
      <ColorBends
        colors={["#ff5c7a", "#8a5cff", "#00ffd1"]}
        rotation={30}
        speed={0.3}
        scale={1.2}
        frequency={1.4}
        warpStrength={1.2}
        mouseInfluence={0.8}
        parallax={0.6}
        noise={0.08}
        transparent
      />
    </div>

    <div style={{zIndex: 100, height: "100vh", width: "100vw", position: 'absolute'}} className="flex justify-center items-center">
      hi
    </div>
    </>
  )
}