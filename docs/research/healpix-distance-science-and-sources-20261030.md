# HEALPix 内部距离展示：物理依据与公开来源核验

核验日期：2026-10-30。本文核验范围为官方文档、官方软件源码中的 DESI DR1 星系试点物理依据与 Gaia 后续路径。随后已按用户提供的 `/mnt/data/desi-dr1` 验证本地 v1 总表、登记只读 Connector，并读取有界真实红移样本；这些工程结果及其完整性边界见[可行性报告](healpix-distance-feasibility-20261030.md)。未下载新的科学文件或读取光谱数组；在线覆盖索引仍不保存天体级物理量。

## 结论与界面措辞

**红移是观测量；由红移计算的距离是依赖宇宙学模型、参考系和运动假设的估计。** 本试点可以把天体放在“由红移推算的视线共动距离”上，不能把这幅图称为精确还原的真实空间。三维结构可能包含本动速度导致的红移空间畸变，细长结构不一定是实际细长结构。[1–4]

推荐固定在距离轴或图例旁的文字：

> 视线共动距离估计 / Mpc。根据 DESI 光谱红移与 Planck18 模型计算；保留源目录参考系，未校正星系本动速度。近距离天体尤其可能偏离其实际位置。

点选天体时至少显示：原始红移及 `ZERR`、红移参考系、距离类型、估计方法/模型、质量筛选结果、来源版本，以及误差包含和不包含的因素。没有完整距离误差模型时，不能把 `ZERR` 传播结果标成“总距离误差”。[3–5]

## 距离究竟依据什么

| 可用依据 | 可以怎样解释径向位置 | 必须保留的限制 |
| --- | --- | --- |
| DESI 光谱拟合红移 `Z` | 谱线变化给出观测红移；在固定模型下映射成视线共动距离估计 | 光谱拟合质量、参考系、本动速度、模型参数均影响解释；未做校正时属于红移空间 |
| 仅有红移，未声明模型/参考系 | 轴直接标“红移 z” | 不写成距离，也不提供 Mpc 刻度 |
| 独立距离目录 | 使用目录实际声明的距离方法、统计量、单位及区间 | 不根据字段名字猜测是共动距离、光度距离还是其他距离 |
| Gaia 视差及距离后验 | 使用可靠距离估计及后验区间，构造银河系尺度视图 | 不能对所有视差一律取倒数，也不能用恒星径向速度/光谱红移当作宇宙学距离 |
| 仅有坐标或文件分区 | 只能在天球上定位 | 不填充随机距离、分区半径或巡天图层偏移 |

共动距离与光行时间、光度距离、角直径距离是不同量，禁止只写一个含义不明的“距离”。本试点选择视线共动距离，是为了展示选区内的空间分布；它不是“光走了多少年的距离”。Hogg 的原始推导及 Astropy 方法说明给出：[1,2]

\[
D_C(z)=\frac{c}{H_0}\int_0^z\frac{dz'}{E(z')},\qquad H(z)=H_0 E(z).
\]

输入这里应是适用于背景膨胀映射的红移。观测红移还包含观察者运动、天体本动等贡献；低速近似可写成速度对红移的扰动，而不能普遍把 `cz` 当作实际退行速度或距离。Hogg 第 3 节明确讨论了观测者/源本动对红移的影响。[1]

### Planck18 必须包含的参数

Astropy 的 `Planck18` 是 `FlatLambdaCDM`，官方实现与参数文件确认：[2,3]

| 参数 | 值 |
| --- | --- |
| `H0` | 67.66 km s⁻¹ Mpc⁻¹ |
| `Om0` | 0.30966 |
| `Ob0` | 0.04897 |
| `Tcmb0` | 2.7255 K |
| `Neff` | 3.046 |
| `m_nu` | [0, 0, 0.06] eV |

不能只用 `sqrt(Om0*(1+z)^3 + 1-Om0)` 后把结果标成完整的 Astropy Planck18：其温度非零，存在光子辐射和有质量中微子贡献。本机安装的 Astropy 7.2.0 给出 `Ogamma0=0.00005402015137139353`、`Onu0=0.0014396743040845244`、`Ode0=0.6888463055445441`；`efunc(z)` 使用随红移变化的中微子项。[2,3]

本机默认 Python 的 `Planck18.comoving_distance` 因缺少 `scipy.integrate` 不能直接执行。可在具备 SciPy 的独立环境执行，或对实际 Astropy `Planck18.efunc(z)` 做经过收敛验证的数值积分；不能悄悄退回另一种模型。记录库版本、完整参数、积分/查表误差和表的适用红移范围。

本轮实现随后在 `/tmp/asa-distance-python` 独立安装 SciPy，使用完整 Astropy 7.2.0 `Planck18.comoving_distance` 生成模型表；4,097 个采样位置的线性插值对照最大误差约 0.00105 Mpc。系统默认 Python 环境没有被替换。

### 为什么低红移尤其需要说明

- 星系本动引起的红移变化不代表宇宙膨胀距离变化。在相同速度扰动下，小红移的相对影响更大；不能因为 `ZERR` 很小，就认为距离非常准确。[1]
- 作为量级示例，若假设 300 km/s 本动，并在低红移近似下比较，`v/(cz)` 在 `z=0.01` 时约 10%，在 `z=0.1` 时约 1%。这是假设性敏感度示例，**不是每个星系的实测误差，也不能拿来作为统一置信区间**。
- `z≤0` 可以是实际观测到的蓝移，不能取绝对值、夹到零或推到正距离。若没有独立距离证据，保留红移/排除计数，不放进正距离三维视图。非有限值与质量失败也应保留原因。
- 不制定“某个 z 以上红移就完全等于距离”的硬阈值。低 z 提示、速度敏感度和用户所选模型应分别展示。
- DESI DR1 官方总览将波长系统写为 **vacuum barycentric**。保留它，不能写成日心或 CMB 参考系。采用 CMB 校正必须另有方向、观察者速度和变换记录；本轮不宣称完成了这一校正。[4]

### 误差分项

`ZERR` 是 best-fit redshift 的拟合不确定度。对固定模型传播成 `D_C(z±ZERR)` 的区间，只表达该项传播；本动、参考系、模型参数、误识别谱线等并不因此自动包含其中。缺失 `ZERR` 不能伪装成零误差。测光红移后续需要概率分布/后验，不能把它当成与光谱红移同精度的单值。[1,3,5]

## DESI DR1 的数据支持

### 原始表字段与联结

官方 redrock 数据模型成功读取，确认如下字段。[5]

- `REDSHIFTS`：`TARGETID`、`Z`（best fit redshift）、`ZERR`（uncertainty）、`ZWARN`（0 表示无警告）、`SPECTYPE`、`DELTACHI2`（与次优拟合的差值）。
- `FIBERMAP`：与 `REDSHIFTS` **逐行匹配**，含 `TARGETID`、`TARGET_RA`、`TARGET_DEC`，坐标注明 ICRS；实际读取时仍校验身份与行数，不能把文件分区中心当作天体位置。
- `EXP_FIBERMAP` 是逐曝光条目，不可直接当作唯一星系清单。

`redrock-main-bright-*.fits` 的 O6 路径键（NSIDE=64）是文件组织方式。真实天体坐标可重新归入更细的 HEALPix；路径元数据本身不能证明所有细格都有天体，也不带来距离精度。[5,6]

### 可解释的第一轮质量筛选

DR1 官方总览的 useful spectra 条件是 `ZCAT_PRIMARY==True`、`OBJTYPE=='TGT'`、`ZWARN==0`；Main Survey 另外排除 `PROGRAM=='other'`。[4]

本轮星系可视化在这些条件上加 `SPECTYPE=='GALAXY'`，显式限定 `SURVEY=='main'`，检查有限且合法的坐标、红移及误差。进入正距离视图另要求 `Z>0`；不满足者分别计数。这个组合是**公开总览条件下的星系可视化样本**，不是 BGS/LRG/ELG 任何一类的科学完备样本或宇宙学清洁样本。不得凭经验加统一的 `DELTACHI2>40` 并称其为所有 DESI 星系的官方规则；不同 tracer 的 LSS 分析需采用对应目录与文档。[4,6]

重复观测应按官方推荐 primary 选择。官方 `desispec.zcatalog` 源码说明 `find_primary_spectra` 考虑 `ZWARN` 和排序列，并计算每个 `TARGETID` 的观测数；具体 release 的已发布 `ZCAT_PRIMARY` 优先于自行复刻最新版算法。不能跨文件“遇到第一个 TARGETID 就保留”。单独 redrock 文件没有建立跨 survey/program 的全局 primary 关系；缺少所需元数据时不能声明已去重。[6,7]

### 现成公开路径与版本风险

官方当前 DR1 数据组织文档推荐 **v1** 汇总目录：[6]

- `https://data.desi.lbl.gov/public/dr1/spectro/redux/iron/zcatalog/v1/zall-pix-iron.fits`：文档标约 20.8 GB，跨 survey/program 的 HEALPix redshift 汇总，`ZCAT_PRIMARY` 标推荐红移。
- `zall-tilecumulative-iron.fits`：约 23.6 GB，另一个 tile-based 汇总；不能不经重复处理就与前者叠加。

本轮只读取描述页面，没有读取这两个科学文件或验证文件内实际列、字节数、哈希。仓库历史 `zall-pix-iron.fits` 扫描必须对照**实际 URL、版本、哈希和 HDU 列**，不能因同名就宣称等同于当前推荐 v1。

官方 Data Access 还明确提供：DESI 数据库、NOIRLab Astro Data Lab 的 EDR/DR1 副本、CosmoHub 的 LSS clustering 子集，以及 SPARCL 光谱服务。[8]

有界样区首选从已授权、已受管目录产生派生列或用标准任务提取。公开数据库是可行的备用来源，后续必须先查表结构再限定列与选区；这轮没有执行 SQL，没有验证可用表名、查询时延或导出上限。SPARCL 主体是光谱检索，当前任务不需要下载 flux 数组。不能把文档列出的服务当作已完成数据接入。

## Gaia 后续路径

Gaia DR3 `gaia_source` 官方数据模型提供 `parallax`、`parallax_error`、`parallax_over_error`，也有 `distance_gspphot`。后者是结合 BP/RP 光谱、G 星等和视差，在单星与模型/先验假设下推断的距离，文档说明它是后验样本的中位数；不是仅由 `1/parallax` 得出的精确距离。[9]

Bailer-Jones 等作者在 MPIA 的原始目录页面说明：多数源的相对视差误差使简单反演不合适；geometric 距离使用视差与方向相关先验，photogeometric 还结合颜色和视星等。采用此类产品要保留方法、先验、分位区间及 Gaia release/source identity，不能只展示一个“距离值”。[10]

因此银河系恒星三维图可行，但数据方法、单位和空间尺度应与 DESI 星系分开。Gaia 文件区间 roster、视差字段和可查询距离目录是三个独立能力。

## 本轮证据状态

成功读取的官方页面包括 DESI DR1 总览、Data Organization、Data Access、redrock 数据模型、官方 `desispec` 源码、Astropy Planck18 文档与参数、Hogg 原文的 NED 镜像、Gaia DR3 数据模型和 Bailer-Jones 作者页。网络偶发 TLS timeout / 403，经有限重试取得的页面才列为已核实。

猜测的 `/doc/releases/dr1/catalogs/` 和 `.../vac/redshift-catalogs/` 返回 404，不能作为有效接口；从官方总览导航取得的 Data Organization 与 Data Access 才是本轮可用入口。Astropy 在线页面版本为 8.2.3，本机为 7.2.0；参数一致不代表可以省略软件版本。本轮未取得所有 LSS tracer 的逐项质量规则，不据此宣称科学分析就绪。

## 原始来源

1. David W. Hogg, *Distance measures in cosmology*，作者原文的 NASA/IPAC NED 镜像：[红移与本动，第 3 节](https://ned.ipac.caltech.edu/level5/Hogg/Hogg3.html)、[视线共动距离，第 4 节](https://ned.ipac.caltech.edu/level5/Hogg/Hogg4.html)。
2. Astropy：[Planck18 官方说明](https://docs.astropy.org/en/stable/api/astropy.cosmology.realizations.Planck18.html)、[官方参数文件](https://github.com/astropy/astropy/blob/main/astropy/cosmology/data/Planck18.ecsv)。
3. Astropy 本机 7.2.0 的 `Planck18`、`FlatLambdaCDM.efunc`、`comoving_distance` 原始实现和 docstring；对应[官方源码](https://github.com/astropy/astropy/tree/main/astropy/cosmology/_src/flrw)。
4. DESI：[DR1 官方总览、useful spectra 条件和波长系统](https://data.desi.lbl.gov/doc/releases/dr1/)，以及其链接的[官方统计 notebook](https://github.com/desihub/dr1paper/blob/main/nb/count-dr1-targets.ipynb)。
5. DESI：[redrock HEALPix 文件官方数据模型](https://desidatamodel.readthedocs.io/en/latest/DESI_SPECTRO_REDUX/SPECPROD/healpix/SURVEY/PROGRAM/PIXGROUP/PIXNUM/redrock-SURVEY-PROGRAM-PIXNUM.html)。
6. DESI：[Data Organization，redshift catalogs 与推荐 v1](https://data.desi.lbl.gov/doc/organization/)；DR1 总览的 LSS 目录说明也见 [4]。
7. DESI 官方软件：[desispec.zcatalog](https://github.com/desihub/desispec/blob/main/py/desispec/zcatalog.py)。
8. DESI：[Data Access，数据库、Data Lab、CosmoHub 和 SPARCL](https://data.desi.lbl.gov/doc/access/)。
9. ESA Gaia：[DR3 gaia_source 数据模型](https://gea.esac.esa.int/archive/documentation/GDR3/Gaia_archive/chap_datamodel/sec_dm_main_source_catalogue/ssec_dm_gaia_source.html)。
10. C. A. L. Bailer-Jones 等：[GeDR3 geometric / photogeometric distances 作者目录页](https://www2.mpia-hd.mpg.de/homes/calj/gedr3_distances.html)。
