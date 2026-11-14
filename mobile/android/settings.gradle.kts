pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "HiveMobile"
include(":app")
include(":core")
include(":streaming")
include(":widget")
include(":playback")
include(":sync")
include(":soulseek")
