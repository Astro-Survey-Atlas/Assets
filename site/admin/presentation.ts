/** Project-specific presentation images for the admin survey inventory.
 *
 * These are deliberately separate from /surveys/*.png, which are coverage
 * previews and must not be presented as mission imagery.
 */
const imageSources: Record<string, string> = {
  euclid: "https://www.esa.int/var/esa/storage/images/science_exploration/space_science/euclid/24495561-6-eng-GB/Euclid_pillars.png",
  desi: "https://www.desi.lbl.gov/wp-content/uploads/sites/8/2018/06/instrument-1.jpg",
  sdss: "https://alasky.cds.unistra.fr/hips-image-services/hips2fits?hips=CDS%2FP%2FSDSS9%2Fcolor&ra=180&dec=0&fov=20&width=640&height=360&format=jpg&projection=TAN",
  galex: "https://archive.stsci.edu/files/live/sites/mast/files/home/missions-and-data/galex-1/_images/coadd_intensity_PS_M31_MOS00-xd-int_2color.jpg",
  "legacy-surveys": "https://commons.wikimedia.org/wiki/Special:FilePath/DECam%20Legacy%20Survey%20has%20its%20first%20data%20release%20%28noaoann15007a%29.tiff?width=640",
  "hsc-ssp": "https://upload.wikimedia.org/wikipedia/commons/c/c8/Hyper_Suprime-Cam_Image_of_Most_Distant_Pair_of_Merging_Quasars_%28noirlab2415b%29.jpg",
  hst: "https://archive.stsci.edu/files/live/sites/mast/files/home/missions-and-data/hst/_images/HST.jpg",
  panstarrs: "https://outerspace.stsci.edu/download/attachments/298812201/PanSTARRS4c_420.jpg?version=1&modificationDate=1482100133000&api=v2",
  des: "https://alasky.cds.unistra.fr/hips-image-services/hips2fits?hips=CDS%2FP%2FDES-DR2%2FColorIRG&ra=90&dec=-50&fov=20&width=640&height=360&format=jpg&projection=TAN",
  "2mass": "https://alasky.cds.unistra.fr/hips-image-services/hips2fits?hips=CDS%2FP%2F2MASS%2Fcolor&ra=180&dec=0&fov=20&width=640&height=360&format=jpg&projection=TAN",
  allwise: "https://alasky.cds.unistra.fr/hips-image-services/hips2fits?hips=CDS%2FP%2FallWISE%2FW1&ra=180&dec=0&fov=20&width=640&height=360&format=jpg&projection=TAN",
  kids: "https://alasky.cds.unistra.fr/hips-image-services/hips2fits?hips=CDS%2FP%2FKiDS%2FDR5%2Fcolor-gri&ra=220&dec=-5&fov=20&width=640&height=360&format=jpg&projection=TAN",
  skymapper: "https://alasky.cds.unistra.fr/hips-image-services/hips2fits?hips=CDS%2FP%2FSkymapper%2FDR4%2Fcolor&ra=180&dec=-30&fov=20&width=640&height=360&format=jpg&projection=TAN",
  vista: "https://www.eso.org/sci/facilities/paranal/telescopes/vista/eso0704b.jpg",
  decals: "https://commons.wikimedia.org/wiki/Special:FilePath/Image%20from%20the%20Dark%20Energy%20Camera%20Legacy%20Survey%20%28noao1902b%29.jpg?width=640",
  gaia: "https://www.cosmos.esa.int/documents/29201/0/Gaia_logo.png/62960d22-cdd9-02a2-c9d0-1bda19ab67cf?t=1607347628590",
  nvss: "https://alasky.cds.unistra.fr/hips-image-services/hips2fits?hips=CDS%2FP%2FNVSS&ra=180&dec=0&fov=20&width=640&height=360&format=jpg&projection=TAN",
  decaps: "https://alasky.cds.unistra.fr/hips-image-services/hips2fits?hips=CDS%2FP%2FDECaPS%2FDR2%2Fcolor&ra=270&dec=-30&fov=20&width=640&height=360&format=jpg&projection=TAN",
  fds: "https://cdn.eso.org/images/screen/eso1725a.jpg",
  iphas: "https://www.iphas.org/assets/images/carousel-ic1396.jpg",
  vphas: "https://www.vphasplus.org/assets/images/carousel-lagoon.jpg",
  ztf: "https://www.ztf.caltech.edu/style/images/features/ZTF22aajijjf.jpg",
  spherex: "https://www.ipac.caltech.edu/system/activities/images/80/page/spherex_NASA_APSv4.jpg?1565396348",
  rubin: "https://storage.googleapis.com/rubin-obs-prod-assets_general/_800xAUTO_crop_center-center_none/Rubin-Marzo-2024-N%C2%BA49.jpg",
  sumss: "https://alasky.cds.unistra.fr/hips-image-services/hips2fits?hips=CDS%2FP%2FSUMSS&ra=180&dec=-30&fov=20&width=640&height=360&format=jpg&projection=TAN",
  wenss: "https://alasky.cds.unistra.fr/hips-image-services/hips2fits?hips=CDS%2FP%2FWENSS&ra=180&dec=45&fov=20&width=640&height=360&format=jpg&projection=TAN",
  cfhtls: "https://alasky.cds.unistra.fr/hips-image-services/hips2fits?hips=CDS%2FP%2FCFHTLS%2FW%2FColor%2Fugi&ra=34&dec=-5&fov=20&width=640&height=360&format=jpg&projection=TAN",
  act: "https://lambda.gsfc.nasa.gov/product/act/act-700.jpg",
  akari: "https://www.ir.isas.jaxa.jp/AKARI/results/20140324_GalHii/PAHs.png",
  jwst: "https://commons.wikimedia.org/wiki/Special:FilePath/Webb%27s%20First%20Deep%20Field.jpg?width=640",
  roman: "https://commons.wikimedia.org/wiki/Special:FilePath/Nancy%20Grace%20Roman%20Space%20Telescope%20Illustrations%20%28Roman%20Space%20Telescope%20Animation2%20Still%29.jpg?width=640",
};

const images: Record<string, string> = Object.fromEntries(
  Object.keys(imageSources).map((id) => [id, `/admin-surveys/${id}.webp`]),
);

const attributions: Record<string, string> = {
  euclid: "ESA / Euclid mission",
  desi: "DESI collaboration / Berkeley Lab",
  sdss: "Sloan Digital Sky Survey via Wikimedia Commons",
  galex: "NASA / STScI MAST / GALEX",
  "legacy-surveys": "DECaLS / NOIRLab via Wikimedia Commons",
  "hsc-ssp": "Subaru HSC / NOIRLab via Wikimedia Commons",
  hst: "NASA / ESA Hubble Space Telescope via Wikimedia Commons",
  panstarrs: "STScI Pan-STARRS1 archive",
  des: "Dark Energy Survey / DECam via Wikimedia Commons",
  "2mass": "2MASS HiPS at CDS / NASA-IPAC",
  allwise: "AllWISE HiPS at CDS / NASA-IPAC",
  kids: "KiDS HiPS at CDS",
  skymapper: "SkyMapper HiPS at CDS / ANU",
  vista: "ESO / VISTA",
  decals: "DECaLS / NOIRLab via Wikimedia Commons",
  gaia: "Gaia DR3 HiPS at CDS / ESA",
  nvss: "NVSS HiPS at CDS",
  decaps: "DECaPS HiPS at CDS / Legacy Surveys",
  fds: "ESO Fornax Deep Survey",
  iphas: "IPHAS collaboration",
  vphas: "VPHAS+ collaboration",
  ztf: "Zwicky Transient Facility / Caltech",
  spherex: "NASA SPHEREx / IPAC",
  rubin: "NSF-DOE Vera C. Rubin Observatory",
  sumss: "SUMSS HiPS at CDS",
  wenss: "WENSS HiPS at CDS",
  cfhtls: "CFHTLS HiPS at CDS",
  act: "NASA LAMBDA / ACT",
  akari: "JAXA / ISAS AKARI",
  jwst: "NASA / ESA / CSA James Webb Space Telescope via Wikimedia Commons",
  roman: "NASA Nancy Grace Roman Space Telescope via Wikimedia Commons",
};

export function surveyPresentationImage(id: string): string | undefined {
  return images[presentationId(id)];
}

export function surveyPresentationAttribution(id: string): string | undefined {
  return attributions[presentationId(id)];
}

export function surveyPresentationSource(id: string): string | undefined {
  return imageSources[presentationId(id)];
}

function presentationId(id: string): string {
  const normalized = id.trim().toLowerCase();
  return normalized === "nancy-grace-roman-space-telescope" ? "roman" : normalized;
}
